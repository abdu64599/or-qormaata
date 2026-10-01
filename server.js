const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// ===============================
// DATABASE
// ===============================

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

// ===============================
// HELPERS
// ===============================

function cleanText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function makeExamCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

// ===============================
// OPTIONS NORMALIZER
// ===============================

function normalizeOptions(options) {
  if (!options) {
    return {
      A: "",
      B: "",
      C: "",
      D: ""
    };
  }

  // Object
  if (!Array.isArray(options) && typeof options === "object") {
    return {
      A: cleanText(options.A ?? options.a ?? ""),
      B: cleanText(options.B ?? options.b ?? ""),
      C: cleanText(options.C ?? options.c ?? ""),
      D: cleanText(options.D ?? options.d ?? "")
    };
  }

  // Array
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

// ===============================
// CORRECT ANSWER NORMALIZER
// ===============================

function normalizeCorrectAnswer(correctAnswer, options, type) {
  const answer = cleanText(correctAnswer);

  if (!answer) return "";

  // True / False
  if (type === "truefalse") {
    const lower = answer.toLowerCase();

    if (
      answer === "A" ||
      lower === "dhugaa" ||
      lower === "true"
    ) {
      return "Dhugaa";
    }

    if (
      answer === "B" ||
      lower === "soba" ||
      lower === "false"
    ) {
      return "Soba";
    }

    return answer;
  }

  // Multiple Choice
  if (
    answer === "A" ||
    answer === "B" ||
    answer === "C" ||
    answer === "D"
  ) {
    return options[answer] || answer;
  }

  return answer;
}

// ===============================
// QUESTION NORMALIZER
// ===============================

function normalizeQuestion(question, index = 0) {
  const type =
    cleanText(
      question.type ||
      question.questionType ||
      question.kind ||
      "multiple"
    ).toLowerCase();

  const finalType =
    type === "truefalse" ||
    type === "true-false" ||
    type === "true_false"
      ? "truefalse"
      : "multiple";

  const options = normalizeOptions(question.options);

  if (finalType === "truefalse") {
    options.A = "Dhugaa";
    options.B = "Soba";
    options.C = "";
    options.D = "";
  }

  const correctAnswer = normalizeCorrectAnswer(
    question.correctAnswer ??
      question.correct_answer ??
      question.answer ??
      "",
    options,
    finalType
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

    type: finalType,

    options,

    correctAnswer,

    points: Number(question.points) || 1
  };
}

// ===============================
// QUESTIONS PARSER
// ===============================

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

  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((q, index) =>
    normalizeQuestion(q, index)
  );
}

// ===============================
// DETAILS PARSER
// ===============================

function parseDetails(value) {
  if (!value) return [];

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  return Array.isArray(value) ? value : [];
}

// ===============================
// ID SEQUENCE FIX
// ===============================

async function ensureIdSequence(tableName, columnName, sequenceName) {
  const sequenceResult = await pool.query(
    `
    SELECT pg_get_serial_sequence($1, $2) AS seq
    `,
    [tableName, columnName]
  );

  let sequence =
    sequenceResult.rows[0]?.seq || null;

  // Existing table has no sequence
  if (!sequence) {
    await pool.query(`
      CREATE SEQUENCE IF NOT EXISTS ${sequenceName}
    `);

    await pool.query(`
      ALTER TABLE ${tableName}
      ALTER COLUMN ${columnName}
      SET DEFAULT nextval('${sequenceName}')
    `);

    try {
      await pool.query(`
        ALTER SEQUENCE ${sequenceName}
        OWNED BY ${tableName}.${columnName}
      `);
    } catch (error) {
      console.log(
        `Sequence ownership warning (${tableName}):`,
        error.message
      );
    }

    sequence = sequenceName;
  }

  // Sync sequence with existing rows
  const maxResult = await pool.query(`
    SELECT COALESCE(MAX(${columnName}), 0) AS max_id
    FROM ${tableName}
  `);

  const maxId = Number(
    maxResult.rows[0]?.max_id || 0
  );

  await pool.query(
    `
    SELECT setval(
      $1::regclass,
      $2,
      false
    )
    `,
    [sequence, maxId + 1]
  );
}

// ===============================
// DATABASE INITIALIZATION
// ===============================

async function initDatabase() {
  console.log("Database initialization started...");

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL hin jiru.");
  }

  // -------------------------------
  // EXAMS TABLE
  // -------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS exams (
      id SERIAL PRIMARY KEY,
      code VARCHAR(30) UNIQUE NOT NULL,
      teacher_name TEXT NOT NULL,
      title TEXT NOT NULL,
      subject TEXT NOT NULL,
      grade TEXT NOT NULL,
      duration INTEGER NOT NULL DEFAULT 30,
      questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // -------------------------------
  // RESULTS TABLE
  // -------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS results (
      id SERIAL PRIMARY KEY,
      exam_id INTEGER NOT NULL
        REFERENCES exams(id)
        ON DELETE CASCADE,

      exam_code VARCHAR(30),

      student_name TEXT NOT NULL,

      score NUMERIC DEFAULT 0,
      total_points NUMERIC DEFAULT 0,
      percentage NUMERIC DEFAULT 0,

      correct_answers INTEGER DEFAULT 0,
      wrong_answers INTEGER DEFAULT 0,
      total_questions INTEGER DEFAULT 0,

      details JSONB NOT NULL DEFAULT '[]'::jsonb,

      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // -------------------------------
  // OLD DATABASE MIGRATION
  // -------------------------------

  await pool.query(`
    ALTER TABLE results
    ADD COLUMN IF NOT EXISTS exam_code VARCHAR(30)
  `);

  // -------------------------------
  // EXAMS ID SEQUENCE
  // -------------------------------

  await ensureIdSequence(
    "exams",
    "id",
    "exams_id_seq"
  );

  // -------------------------------
  // RESULTS ID SEQUENCE
  // -------------------------------

  await ensureIdSequence(
    "results",
    "id",
    "results_id_seq"
  );

  // -------------------------------
  // OLD RESULTS EXAM CODE
  // -------------------------------

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

  // -------------------------------
  // INDEXES
  // -------------------------------

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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_results_submitted_at
    ON results(submitted_at)
  `);

  console.log("Database migrations completed.");
}

// ===============================
// HEALTH / STATUS
// ===============================

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
      app: "OR - Sirna Qormaataa Barattootaa",
      database: "error",
      error: error.message
    });
  }
});

// ===============================
// CREATE EXAM
// ===============================

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
        error: "Kutaan/barataan barbaachisaadha."
      });
    }

    if (finalQuestions.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Gaaffiin tokko illee hin kuufamne."
      });
    }

    for (const q of finalQuestions) {
      if (!q.text) {
        return res.status(400).json({
          success: false,
          error: "Gaaffii keessaa tokko maqaa/text hin qabu."
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

    // Make sure code is unique
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
        error: "Exam code uumuu hin dandeenye."
      });
    }

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
      RETURNING id, code, teacher_name, title,
                subject, grade, duration,
                questions, created_at
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

// ===============================
// GET EXAM
// ===============================

app.get("/api/exams/:code", async (req, res) => {
  try {
    const code = cleanText(
      req.params.code
    ).toUpperCase();

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
        error: "Qormaanni kun hin argamne."
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

// ===============================
// SUBMIT EXAM
// ===============================

app.post(
  "/api/exams/:code/submit",
  async (req, res) => {
    try {
      const code = cleanText(
        req.params.code
      ).toUpperCase();

      const studentName = cleanText(
        req.body.studentName ||
        req.body.student_name
      );

      const answers =
        req.body.answers;

      if (!studentName) {
        return res.status(400).json({
          success: false,
          error: "Maqaan barataa barbaachisaadha."
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

      // -------------------------------
      // GET EXAM
      // -------------------------------

      const examResult = await pool.query(
        `
        SELECT *
        FROM exams
        WHERE UPPER(code) = $1
        LIMIT 1
        `,
        [code]
      );

      if (examResult.rowCount === 0) {
        return res.status(404).json({
          success: false,
          error: "Qormaanni kun hin argamne."
        });
      }

      const exam =
        examResult.rows[0];

      const questions =
        parseQuestions(exam.questions);

      // -------------------------------
      // CHECK ANSWERS
      // -------------------------------

      let score = 0;
      let totalPoints = 0;
      let correctAnswers = 0;
      let wrongAnswers = 0;

      const details = [];

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];

        const points =
          Number(q.points) || 1;

        totalPoints += points;

        let studentAnswer =
          answers[q.id];

        // Some frontend versions may use index
        if (
          studentAnswer === undefined &&
          answers[String(i)] !== undefined
        ) {
          studentAnswer =
            answers[String(i)];
        }

        studentAnswer =
          cleanText(studentAnswer);

        // Convert A/B/C/D into actual option text
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
            studentAnswer || "Hin deebifne",

          correctAnswer,

          isCorrect,

          points: isCorrect
            ? points
            : 0,

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

      // -------------------------------
      // SAVE RESULT
      // -------------------------------

      const resultInsert =
        await pool.query(
          `
          INSERT INTO results
          (
            exam_id,
            exam_code,
            student_name,
            score,
            total_points,
            percentage,
            correct_answers,
            wrong_answers,
            total_questions,
            details
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10::jsonb
          )
          RETURNING
            id,
            exam_id,
            exam_code,
            student_name,
            score,
            total_points,
            percentage,
            correct_answers,
            wrong_answers,
            total_questions,
            details,
            submitted_at
          `,
          [
            exam.id,
            exam.code,
            studentName,
            score,
            totalPoints,
            percentage,
            correctAnswers,
            wrongAnswers,
            questions.length,
            JSON.stringify(details)
          ]
        );

      const saved =
        resultInsert.rows[0];

      res.json({
        success: true,

        message:
          "Qormaanni milkaa'inaan xumurame.",

        result: {
          id: saved.id,

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

// ===============================
// TEACHER RESULTS
// ===============================

app.get(
  "/api/exams/:code/results",
  async (req, res) => {
    try {
      const code = cleanText(
        req.params.code
      ).toUpperCase();

      const examResult =
        await pool.query(
          `
          SELECT id, code, title
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
            total_points AS "totalPoints",
            percentage,
            correct_answers AS "correctAnswers",
            wrong_answers AS "wrongAnswers",
            total_questions AS "totalQuestions",
            submitted_at AS "submittedAt"
          FROM results
          WHERE exam_id = $1
          ORDER BY submitted_at DESC
          `,
          [exam.id]
        );

      res.json({
        success: true,

        exam: {
          id: exam.id,
          code: exam.code,
          title: exam.title
        },

        results:
          results.rows
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

// ===============================
// ONE STUDENT RESULT
// ===============================

app.get(
  "/api/results/:id",
  async (req, res) => {
    try {
      const id =
        Number(req.params.id);

      if (!Number.isInteger(id)) {
        return res.status(400).json({
          success: false,
          error: "Result ID sirrii miti."
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
            r.total_points AS "totalPoints",
            r.percentage,
            r.correct_answers AS "correctAnswers",
            r.wrong_answers AS "wrongAnswers",
            r.total_questions AS "totalQuestions",
            r.details,
            r.submitted_at AS "submittedAt",

            e.title AS "examTitle",
            e.subject,
            e.grade,
            e.teacher_name AS "teacherName"

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

// ===============================
// DELETE EXAM
// ===============================

app.delete(
  "/api/exams/:code",
  async (req, res) => {
    try {
      const code = cleanText(
        req.params.code
      ).toUpperCase();

      const result =
        await pool.query(
          `
          DELETE FROM exams
          WHERE UPPER(code) = $1
          RETURNING id, code
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

// ===============================
// FRONTEND
// ===============================

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

// ===============================
// START SERVER
// ===============================

async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `🚀 OR server running on port ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "❌ Database initialization failed:",
      error
    );

    process.exit(1);
  }
}

startServer();
