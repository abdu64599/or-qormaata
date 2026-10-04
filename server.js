const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL hin argamne.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.includes("localhost")
      ? { rejectUnauthorized: false }
      : false,
  connectionTimeoutMillis: 15000
});

// =====================================================
// HELPERS
// =====================================================

function cleanText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function makeExamCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

// =====================================================
// OPTIONS
// =====================================================

function normalizeOptions(options) {
  if (!options) {
    return {
      A: "",
      B: "",
      C: "",
      D: ""
    };
  }

  if (!Array.isArray(options) && typeof options === "object") {
    return {
      A: cleanText(options.A ?? options.a ?? ""),
      B: cleanText(options.B ?? options.b ?? ""),
      C: cleanText(options.C ?? options.c ?? ""),
      D: cleanText(options.D ?? options.d ?? "")
    };
  }

  if (Array.isArray(options)) {
    return {
      A: cleanText(options[0] ?? ""),
      B: cleanText(options[1] ?? ""),
      C: cleanText(options[2] ?? ""),
      D: cleanText(options[3] ?? "")
    };
  }

  return {
    A: "",
    B: "",
    C: "",
    D: ""
  };
}

// =====================================================
// CORRECT ANSWER
// =====================================================

function normalizeCorrectAnswer(answer, options, type) {
  const value = cleanText(answer);

  if (!value) return "";

  if (type === "truefalse") {
    const lower = value.toLowerCase();

    if (
      value === "A" ||
      lower === "true" ||
      lower === "dhugaa"
    ) {
      return "Dhugaa";
    }

    if (
      value === "B" ||
      lower === "false" ||
      lower === "soba"
    ) {
      return "Soba";
    }

    return value;
  }

  if (["A", "B", "C", "D"].includes(value)) {
    return options[value] || value;
  }

  return value;
}

// =====================================================
// QUESTION
// =====================================================

function normalizeQuestion(question, index = 0) {
  question = question || {};

  const rawType = cleanText(
    question.type ||
    question.questionType ||
    question.kind ||
    "multiple"
  ).toLowerCase();

  const type =
    rawType === "truefalse" ||
    rawType === "true-false" ||
    rawType === "true_false"
      ? "truefalse"
      : "multiple";

  const options = normalizeOptions(
    question.options
  );

  if (type === "truefalse") {
    options.A = "Dhugaa";
    options.B = "Soba";
    options.C = "";
    options.D = "";
  }

  const correctAnswer =
    normalizeCorrectAnswer(
      question.correctAnswer ??
        question.correct_answer ??
        question.answer ??
        "",
      options,
      type
    );

  return {
    id:
      question.id ||
      `q_${Date.now()}_${index}_${crypto
        .randomBytes(2)
        .toString("hex")}`,

    text: cleanText(
      question.text ||
      question.question ||
      question.questionText ||
      ""
    ),

    type,

    options,

    correctAnswer,

    points:
      Number(question.points) > 0
        ? Number(question.points)
        : 1
  };
}

// =====================================================
// PARSE QUESTIONS
// =====================================================

function parseQuestions(value) {
  if (!value) return [];

  let data = value;

  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(data)) return [];

  return data.map((q, i) =>
    normalizeQuestion(q, i)
  );
}

// =====================================================
// PARSE DETAILS
// =====================================================

function parseDetails(value) {
  if (!value) return [];

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return Array.isArray(value) ? value : [];
}

// =====================================================
// DATABASE INITIALIZATION
// IMPORTANT:
// OR DATABASE USES INTEGER IDs.
// DO NOT CHANGE TO UUID.
// =====================================================

async function initDatabase() {
  console.log("Database initialization started...");

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL hin jiru.");
  }

  // ---------------------------------------------------
  // Make sure questions column exists
  // ---------------------------------------------------

  await pool.query(`
    ALTER TABLE exams
    ADD COLUMN IF NOT EXISTS questions
    JSONB NOT NULL DEFAULT '[]'::jsonb
  `);

  // ---------------------------------------------------
  // RESULTS EXTRA COLUMNS
  // Existing OR table is preserved.
  // ---------------------------------------------------

  await pool.query(`
    ALTER TABLE results
    ADD COLUMN IF NOT EXISTS exam_code VARCHAR(30)
  `);

  await pool.query(`
    ALTER TABLE results
    ADD COLUMN IF NOT EXISTS total_points NUMERIC DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE results
    ADD COLUMN IF NOT EXISTS correct_answers INTEGER DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE results
    ADD COLUMN IF NOT EXISTS wrong_answers INTEGER DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE results
    ADD COLUMN IF NOT EXISTS total_questions INTEGER DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE results
    ADD COLUMN IF NOT EXISTS details
    JSONB DEFAULT '[]'::jsonb
  `);

  await pool.query(`
    ALTER TABLE results
    ADD COLUMN IF NOT EXISTS submitted_at
    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  `);

  // ---------------------------------------------------
  // Fill exam_code for old results
  // ---------------------------------------------------

  try {
    await pool.query(`
      UPDATE results r
      SET exam_code = e.code
      FROM exams e
      WHERE r.exam_id = e.id
        AND (
          r.exam_code IS NULL
          OR r.exam_code = ''
        )
    `);
  } catch (error) {
    console.log(
      "exam_code migration warning:",
      error.message
    );
  }

  // ---------------------------------------------------
  // INDEXES
  // ---------------------------------------------------

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_exams_code
    ON exams(code)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_results_exam_id
    ON results(exam_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_results_exam_code
    ON results(exam_code)
  `);

  console.log(
    "✅ Database migrations completed."
  );
}

// =====================================================
// HEALTH
// =====================================================

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      app: "OR - Sirna Qormaataa Barattootaa",
      database: "connected",
      status: "online"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      database: "error",
      error: error.message
    });
  }
});

// =====================================================
// STATUS
// =====================================================

app.get("/api/status", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      app: "OR - Sirna Qormaataa Barattootaa",
      database: "connected",
      status: "online"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      database: "error",
      error: error.message
    });
  }
});

// =====================================================
// CREATE EXAM
// =====================================================

app.post("/api/exams", async (req, res) => {
  try {
    const {
      teacherName,
      teacher_name,
      title,
      examTitle,
      subject,
      grade,
      duration,
      questions
    } = req.body;

    const finalTeacherName = cleanText(
      teacherName || teacher_name
    );

    const finalTitle = cleanText(
      title || examTitle
    );

    const finalSubject = cleanText(subject);
    const finalGrade = cleanText(grade);

    const finalDuration =
      Number(duration) > 0
        ? Number(duration)
        : 30;

    const finalQuestions =
      parseQuestions(questions);

    if (!finalTeacherName) {
      return res.status(400).json({
        success: false,
        error: "Maqaan barsiisaa barbaachisaadha."
      });
    }

    if (!finalTitle) {
      return res.status(400).json({
        success: false,
        error: "Mata-dureen qormaataa barbaachisaadha."
      });
    }

    if (!finalSubject) {
      return res.status(400).json({
        success: false,
        error: "Barnootni barbaachisaadha."
      });
    }

    if (!finalGrade) {
      return res.status(400).json({
        success: false,
        error: "Kutaan barbaachisaadha."
      });
    }

    if (finalQuestions.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          "Gaaffiin tokko illee hin kuufamne."
      });
    }

    for (const q of finalQuestions) {
      if (!q.text) {
        return res.status(400).json({
          success: false,
          error:
            "Gaaffii tokko text hin qabu."
        });
      }

      if (!q.correctAnswer) {
        return res.status(400).json({
          success: false,
          error:
            `Deebiin sirrii gaaffii "${q.text}" hin guutamne.`
        });
      }
    }

    let code = "";

    for (let i = 0; i < 10; i++) {
      const candidate = makeExamCode();

      const exists = await pool.query(
        `
        SELECT id
        FROM exams
        WHERE code = $1
        `,
        [candidate]
      );

      if (exists.rowCount === 0) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      return res.status(500).json({
        success: false,
        error:
          "Exam code uumuu hin dandeenye."
      });
    }

    // IMPORTANT:
    // Do NOT provide UUID.
    // PostgreSQL INTEGER id generates automatically.
    const insertResult = await pool.query(
      `
      INSERT INTO exams
      (
        code,
        teacher_name,
        title,
        subject,
        grade,
        duration,
        questions
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::jsonb
      )
      RETURNING
        id,
        code,
        teacher_name,
        title,
        subject,
        grade,
        duration,
        questions,
        created_at
      `,
      [
        code,
        finalTeacherName,
        finalTitle,
        finalSubject,
        finalGrade,
        finalDuration,
        JSON.stringify(finalQuestions)
      ]
    );

    const exam = insertResult.rows[0];

    const baseUrl =
      `${req.protocol}://${req.get("host")}`;

    const link =
      `${baseUrl}/?exam=${encodeURIComponent(code)}`;

    res.status(201).json({
      success: true,
      message:
        "Qormaanni milkaa'inaan uumame.",
      exam,
      code,
      link,
      shareText:
        `Qormaata "${finalTitle}" fudhachuuf linkii kana bani: ${link}`
    });

  } catch (error) {
    console.error(
      "❌ CREATE EXAM ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error:
        "Qormaata uumuu irratti rakkoon uumame: " +
        error.message
    });
  }
});

// =====================================================
// GET EXAM
// =====================================================

app.get("/api/exams/:code", async (req, res) => {
  try {
    const code =
      cleanText(req.params.code).toUpperCase();

    const result = await pool.query(
      `
      SELECT
        id,
        code,
        teacher_name AS "teacherName",
        title,
        subject,
        grade,
        duration,
        questions,
        created_at AS "createdAt"
      FROM exams
      WHERE UPPER(code) = $1
      LIMIT 1
      `,
      [code]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error:
          "Qormaanni kun hin argamne."
      });
    }

    const exam = result.rows[0];

    exam.questions =
      parseQuestions(exam.questions);

    res.json({
      success: true,
      exam
    });

  } catch (error) {
    console.error(
      "GET EXAM ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================================
// SUBMIT EXAM
// =====================================================

app.post(
  "/api/exams/:code/submit",
  async (req, res) => {
    try {
      const code =
        cleanText(req.params.code).toUpperCase();

      const studentName =
        cleanText(
          req.body.studentName ||
          req.body.student_name
        );

      const answers = req.body.answers;

      if (!studentName) {
        return res.status(400).json({
          success: false,
          error:
            "Maqaan barataa barbaachisaadha."
        });
      }

      if (
        !answers ||
        typeof answers !== "object" ||
        Array.isArray(answers)
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Deebiin qormaataa hin argamne."
        });
      }

      const examResult =
        await pool.query(
          `
          SELECT
            id,
            code,
            title,
            subject,
            grade,
            duration,
            questions
          FROM exams
          WHERE UPPER(code) = $1
          LIMIT 1
          `,
          [code]
        );

      if (examResult.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error:
            "Qormaanni kun hin argamne."
        });
      }

      const exam =
        examResult.rows[0];

      const questions =
        parseQuestions(exam.questions);

      if (questions.length === 0) {
        return res.status(400).json({
          success: false,
          error:
            "Qormaata kana keessatti gaaffiin hin jiru."
        });
      }

      let score = 0;
      let totalPoints = 0;
      let correctAnswers = 0;
      let wrongAnswers = 0;

      const details = [];

      for (
        let i = 0;
        i < questions.length;
        i++
      ) {
        const q = questions[i];

        const points =
          Number(q.points) || 1;

        totalPoints += points;

        let studentAnswer =
          answers[q.id];

        if (
          studentAnswer === undefined &&
          answers[String(i)] !== undefined
        ) {
          studentAnswer =
            answers[String(i)];
        }

        studentAnswer =
          cleanText(studentAnswer);

        // Multiple choice
        if (
          q.type === "multiple" &&
          ["A", "B", "C", "D"].includes(
            studentAnswer
          )
        ) {
          studentAnswer =
            q.options[studentAnswer] ||
            studentAnswer;
        }

        // True / False
        if (q.type === "truefalse") {
          const lower =
            studentAnswer.toLowerCase();

          if (
            studentAnswer === "A" ||
            lower === "true" ||
            lower === "dhugaa"
          ) {
            studentAnswer = "Dhugaa";
          }

          if (
            studentAnswer === "B" ||
            lower === "false" ||
            lower === "soba"
          ) {
            studentAnswer = "Soba";
          }
        }

        const correctAnswer =
          cleanText(q.correctAnswer);

        const isCorrect =
          studentAnswer !== "" &&
          studentAnswer.toLowerCase() ===
            correctAnswer.toLowerCase();

        if (isCorrect) {
          score += points;
          correctAnswers++;
        } else {
          wrongAnswers++;
        }

        details.push({
          questionId: q.id,
          questionNumber: i + 1,
          question: q.text,
          type: q.type,
          studentAnswer:
            studentAnswer ||
            "Hin deebifne",
          correctAnswer,
          isCorrect,
          points:
            isCorrect ? points : 0,
          maxPoints: points
        });
      }

      const percentage =
        totalPoints > 0
          ? Number(
              (
                (score / totalPoints) *
                100
              ).toFixed(2)
            )
          : 0;

      // INTEGER result ID:
      // Do NOT provide UUID.
      const insertResult =
        await pool.query(
          `
          INSERT INTO results
          (
            exam_id,
            exam_code,
            student_name,
            score,
            total,
            percentage,
            answers,
            total_points,
            correct_answers,
            wrong_answers,
            total_questions,
            details,
            submitted_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7::jsonb,
            $8,
            $9,
            $10,
            $11,
            $12::jsonb,
            CURRENT_TIMESTAMP
          )
          RETURNING id
          `,
          [
            exam.id,
            exam.code,
            studentName,
            score,
            totalPoints,
            percentage,
            JSON.stringify(answers),
            totalPoints,
            correctAnswers,
            wrongAnswers,
            questions.length,
            JSON.stringify(details)
          ]
        );

      const resultId =
        insertResult.rows[0].id;

      res.json({
        success: true,

        message:
          "Qormaanni milkaa'inaan xumurame.",

        result: {
          id: resultId,
          examCode: exam.code,
          studentName,
          score,
          totalPoints,
          percentage,
          correctAnswers,
          wrongAnswers,
          totalQuestions:
            questions.length,
          details
        }
      });

    } catch (error) {
      console.error(
        "❌ SUBMIT EXAM ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Qormaata erguu irratti rakkoon uumame: " +
          error.message
      });
    }
  }
);

// =====================================================
// ALL RESULTS FOR TEACHER
// =====================================================

app.get(
  "/api/exams/:code/results",
  async (req, res) => {
    try {
      const code =
        cleanText(req.params.code).toUpperCase();

      const examResult =
        await pool.query(
          `
          SELECT
            id,
            code,
            title,
            teacher_name,
            subject,
            grade
          FROM exams
          WHERE UPPER(code) = $1
          LIMIT 1
          `,
          [code]
        );

      if (examResult.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error:
            "Qormaanni kun hin argamne."
        });
      }

      const exam =
        examResult.rows[0];

      const results =
        await pool.query(
          `
          SELECT
            id,
            student_name AS "studentName",
            score,
            total,
            total_points AS "totalPoints",
            percentage,
            correct_answers AS "correctAnswers",
            wrong_answers AS "wrongAnswers",
            total_questions AS "totalQuestions",
            details,
            submitted_at AS "submittedAt",
            created_at AS "createdAt"
          FROM results
          WHERE exam_id = $1
          ORDER BY submitted_at DESC NULLS LAST,
                   created_at DESC NULLS LAST,
                   id DESC
          `,
          [exam.id]
        );

      const formattedResults =
        results.rows.map((row) => ({
          ...row,
          details:
            parseDetails(row.details)
        }));

      res.json({
        success: true,

        exam: {
          id: exam.id,
          code: exam.code,
          title: exam.title,
          teacherName:
            exam.teacher_name,
          subject: exam.subject,
          grade: exam.grade
        },

        results:
          formattedResults
      });

    } catch (error) {
      console.error(
        "GET RESULTS ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// =====================================================
// ONE STUDENT RESULT
// =====================================================

app.get(
  "/api/results/:id",
  async (req, res) => {
    try {
      const id =
        Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          success: false,
          error:
            "Result ID sirrii miti."
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            r.id,
            r.exam_id,
            r.exam_code AS "examCode",
            r.student_name AS "studentName",
            r.score,
            r.total,
            r.total_points AS "totalPoints",
            r.percentage,
            r.correct_answers AS "correctAnswers",
            r.wrong_answers AS "wrongAnswers",
            r.total_questions AS "totalQuestions",
            r.answers,
            r.details,
            r.submitted_at AS "submittedAt",
            r.created_at AS "createdAt",

            e.title AS "examTitle",
            e.subject,
            e.grade,
            e.teacher_name AS "teacherName",
            e.code AS "examCodeFromExam"

          FROM results r

          JOIN exams e
            ON e.id = r.exam_id

          WHERE r.id = $1

          LIMIT 1
          `,
          [id]
        );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error:
            "Bu'aa barataa hin argamne."
        });
      }

      const row =
        result.rows[0];

      row.details =
        parseDetails(row.details);

      res.json({
        success: true,
        result: row
      });

    } catch (error) {
      console.error(
        "GET STUDENT RESULT ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// =====================================================
// DELETE EXAM
// =====================================================

app.delete(
  "/api/exams/:code",
  async (req, res) => {
    try {
      const code =
        cleanText(req.params.code).toUpperCase();

      const result =
        await pool.query(
          `
          DELETE FROM exams
          WHERE UPPER(code) = $1
          RETURNING id, code, title
          `,
          [code]
        );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error:
            "Qormaata haqamu hin argamne."
        });
      }

      res.json({
        success: true,
        message:
          "Qormaanni haqame.",
        exam:
          result.rows[0]
      });

    } catch (error) {
      console.error(
        "DELETE EXAM ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// =====================================================
// FRONTEND
// =====================================================

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

// =====================================================
// START
// =====================================================

async function startServer() {
  try {
    await initDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `🚀 OR server running on port ${PORT}`
        );
      }
    );

  } catch (error) {
    console.error(
      "❌ Database initialization failed:",
      error
    );

    process.exit(1);
  }
}

startServer();
