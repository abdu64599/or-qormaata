const express = require("express");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

// ===============================
// MIDDLEWARE
// ===============================

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// ===============================
// DATABASE
// ===============================

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL hin argamne.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ===============================
// HELPERS
// ===============================

function cleanText(value, max = 500) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim().slice(0, max);
}

async function createExamCode() {
  for (let i = 0; i < 30; i++) {
    const code = crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase();

    const check = await pool.query(
      "SELECT id FROM exams WHERE code = $1",
      [code]
    );

    if (check.rows.length === 0) {
      return code;
    }
  }

  throw new Error("Exam code uumuu hin dandeenye.");
}

// ===============================
// DATABASE INITIALIZATION
// ===============================

async function initDatabase() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS exams (
        id UUID PRIMARY KEY,
        code VARCHAR(20) UNIQUE NOT NULL,
        teacher_name VARCHAR(150) NOT NULL,
        title VARCHAR(250) NOT NULL,
        subject VARCHAR(150),
        grade VARCHAR(100),
        duration INTEGER NOT NULL DEFAULT 30,
        questions JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS results (
        id UUID PRIMARY KEY,
        exam_id UUID NOT NULL
          REFERENCES exams(id)
          ON DELETE CASCADE,
        student_name VARCHAR(150) NOT NULL,
        answers JSONB NOT NULL DEFAULT '{}'::jsonb,
        details JSONB NOT NULL DEFAULT '[]'::jsonb,
        score INTEGER NOT NULL DEFAULT 0,
        total_points INTEGER NOT NULL DEFAULT 0,
        correct_answers INTEGER NOT NULL DEFAULT 0,
        wrong_answers INTEGER NOT NULL DEFAULT 0,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      ALTER TABLE results
      ADD COLUMN IF NOT EXISTS details JSONB
      DEFAULT '[]'::jsonb;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_exams_code
      ON exams(code);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_results_exam_id
      ON results(exam_id);
    `);

    await client.query("COMMIT");

    console.log("Database migrations completed.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ===============================
// STATUS
// ===============================

app.get("/api/status", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      app: "OR",
      database: "Render PostgreSQL",
      status: "online"
    });
  } catch (error) {
    console.error("STATUS ERROR:", error);

    res.status(500).json({
      success: false,
      app: "OR",
      database: "Render PostgreSQL",
      status: "offline"
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
      title,
      subject,
      grade,
      duration,
      questions
    } = req.body;

    if (!cleanText(teacherName)) {
      return res.status(400).json({
        success: false,
        error: "Maqaa barsiisaa galchi."
      });
    }

    if (!cleanText(title)) {
      return res.status(400).json({
        success: false,
        error: "Mata duree qormaataa galchi."
      });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Yoo xiqqaate gaaffii tokko kuusi."
      });
    }

    const cleanQuestions = [];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];

      const type =
        q.type === "truefalse"
          ? "truefalse"
          : "multiple";

      const question = cleanText(q.question, 2000);

      if (!question) {
        return res.status(400).json({
          success: false,
          error: `Gaaffii ${i + 1} guuti.`
        });
      }

      const points =
        Number(q.points) > 0
          ? Number(q.points)
          : 1;

      let options = [];
      let answer = "";

      // -------------------------------
      // MULTIPLE CHOICE
      // -------------------------------

      if (type === "multiple") {
        if (Array.isArray(q.options)) {
          options = q.options
            .map(item => cleanText(item, 500))
            .filter(Boolean)
            .slice(0, 4);
        } else if (
          q.options &&
          typeof q.options === "object"
        ) {
          options = [
            q.options.A,
            q.options.B,
            q.options.C,
            q.options.D
          ]
            .map(item => cleanText(item, 500))
            .filter(Boolean)
            .slice(0, 4);
        }

        if (options.length < 2) {
          return res.status(400).json({
            success: false,
            error:
              `Gaaffii ${i + 1} yoo xiqqaate filannoo lama qabaachuu qaba.`
          });
        }

        const rawAnswer = cleanText(
          q.correctAnswer || q.answer,
          500
        );

        const letters = ["A", "B", "C", "D"];

        const answerIndex = letters.indexOf(
          rawAnswer.toUpperCase()
        );

        if (answerIndex >= 0 && options[answerIndex]) {
          answer = options[answerIndex];
        } else {
          answer = rawAnswer;
        }

        if (!answer) {
          return res.status(400).json({
            success: false,
            error:
              `Deebii sirrii gaaffii ${i + 1} galchi.`
          });
        }

        const exists = options.some(
          option =>
            option.toLowerCase() ===
            answer.toLowerCase()
        );

        if (!exists) {
          return res.status(400).json({
            success: false,
            error:
              `Deebiin sirrii gaaffii ${i + 1} filannoo keessaa ta'uu qaba.`
          });
        }
      }

      // -------------------------------
      // TRUE / FALSE
      // -------------------------------

      if (type === "truefalse") {
        options = ["Dhugaa", "Soba"];

        const rawAnswer = cleanText(
          q.correctAnswer || q.answer,
          100
        ).toLowerCase();

        if (
          rawAnswer === "dhugaa" ||
          rawAnswer === "true"
        ) {
          answer = "Dhugaa";
        } else if (
          rawAnswer === "soba" ||
          rawAnswer === "false"
        ) {
          answer = "Soba";
        } else {
          return res.status(400).json({
            success: false,
            error:
              `Gaaffii ${i + 1}: Dhugaa ykn Soba filadhu.`
          });
        }
      }

      cleanQuestions.push({
        id: q.id || crypto.randomUUID(),
        number: i + 1,
        type,
        question,
        options,
        answer,
        points
      });
    }

    // ===============================
    // SAVE EXAM
    // ===============================

    const id = crypto.randomUUID();
    const code = await createExamCode();

    const finalDuration =
      Number(duration) > 0
        ? Number(duration)
        : 30;

    const result = await pool.query(
      `
      INSERT INTO exams
      (
        id,
        code,
        teacher_name,
        title,
        subject,
        grade,
        duration,
        questions
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING
        id,
        code,
        teacher_name,
        title,
        subject,
        grade,
        duration,
        created_at
      `,
      [
        id,
        code,
        cleanText(teacherName, 150),
        cleanText(title, 250),
        cleanText(subject, 150),
        cleanText(grade, 100),
        finalDuration,
        JSON.stringify(cleanQuestions)
      ]
    );

    const baseUrl =
      `${req.protocol}://${req.get("host")}`;

    const link =
      `${baseUrl}/?exam=${code}`;

    res.status(201).json({
      success: true,
      message: "Qormaanni uumameera.",
      code,
      link,
      exam: result.rows[0]
    });
  } catch (error) {
    console.error("CREATE EXAM ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Qormaata uumuu irratti rakkoon uumame."
    });
  }
});

// ===============================
// GET EXAM
// ===============================

app.get("/api/exams/:code", async (req, res) => {
  try {
    const code = cleanText(
      req.params.code,
      20
    ).toUpperCase();

    const result = await pool.query(
      `
      SELECT
        id,
        code,
        teacher_name,
        title,
        subject,
        grade,
        duration,
        questions,
        created_at
      FROM exams
      WHERE code = $1
      `,
      [code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Qormaanni kun hin argamne."
      });
    }

    const exam = result.rows[0];

    const questions =
      Array.isArray(exam.questions)
        ? exam.questions.map(q => ({
            id: q.id,
            number: q.number,
            type: q.type,
            question: q.question,
            options: q.options,
            points: q.points
          }))
        : [];

    res.json({
      success: true,
      id: exam.id,
      code: exam.code,
      teacherName: exam.teacher_name,
      title: exam.title,
      subject: exam.subject,
      grade: exam.grade,
      duration: exam.duration,
      questions
    });
  } catch (error) {
    console.error("GET EXAM ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Qormaata furuun hin danda'amne."
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
        req.params.code,
        20
      ).toUpperCase();

      const studentName = cleanText(
        req.body.studentName,
        150
      );

      const answers = req.body.answers;

      if (!studentName) {
        return res.status(400).json({
          success: false,
          error: "Maqaa barataa galchi."
        });
      }
if (
  !answers ||
  typeof answers !== "object" ||
  Array.isArray(answers)
) {
  return res.status(400).json({
    success: false,
    error: "Deebiin qormaataa hin argamne."
  });
}

      const examResult = await pool.query(
        "SELECT * FROM exams WHERE code = $1",
        [code]
      );

      if (examResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Qormaanni hin argamne."
        });
      }

      const exam = examResult.rows[0];

      let score = 0;
      let totalPoints = 0;
      let correctAnswers = 0;
      let wrongAnswers = 0;

      const details = [];

      for (const q of exam.questions) {
        const points =
          Number(q.points) || 1;

        totalPoints += points;
let studentAnswer =
  answers[q.id] === undefined
    ? ""
    : String(answers[q.id]).trim();

const correctAnswer =
  String(q.answer || "").trim();

// A/B/C/D yoo frontend irraa dhufe,
// gara barruu filannoo isaatti jijjiiri.
if (
  q.type === "multiple" &&
  /^[A-Da-d]$/.test(studentAnswer) &&
  Array.isArray(q.options)
) {
  const index =
    studentAnswer.toUpperCase().charCodeAt(0) -
    "A".charCodeAt(0);

  if (q.options[index] !== undefined) {
    studentAnswer =
      String(q.options[index]).trim();
  }
}

const correct =
  studentAnswer.toLowerCase() ===
  correctAnswer.toLowerCase();

        if (correct) {
          score += points;
          correctAnswers++;
        } else {
          wrongAnswers++;
        }

        details.push({
          questionId: q.id,
          questionNumber: q.number,
          question: q.question,
          type: q.type,
          options: q.options,
          studentAnswer,
          correctAnswer,
          correct,
          earnedPoints: correct ? points : 0,
          maxPoints: points
        });
      }

      const resultId =
        crypto.randomUUID();

      await pool.query(
        `
        INSERT INTO results
        (
          id,
          exam_id,
          student_name,
          answers,
          details,
          score,
          total_points,
          correct_answers,
          wrong_answers
        )
        VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          resultId,
          exam.id,
          studentName,
          JSON.stringify(answers),
          JSON.stringify(details),
          score,
          totalPoints,
          correctAnswers,
          wrongAnswers
        ]
      );

      const percentage =
        totalPoints > 0
          ? Math.round(
              (score / totalPoints) * 100
            )
          : 0;

      res.json({
        success: true,
        message: "Qormaanni xumurameera.",
        id: resultId,
        result: {
          id: resultId,
          examCode: exam.code,
          examTitle: exam.title,
          studentName,
          score,
          totalPoints,
          percentage,
          correctAnswers,
          wrongAnswers,
          totalQuestions:
            exam.questions.length,
          details
        }
      });
    } catch (error) {
      console.error(
        "SUBMIT EXAM ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Qormaata erguu irratti rakkoon uumame."
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
        req.params.code,
        20
      ).toUpperCase();

      const examResult = await pool.query(
        `
        SELECT
          id,
          code,
          title,
          teacher_name,
          subject,
          grade
        FROM exams
        WHERE code = $1
        `,
        [code]
      );

      if (examResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Qormaanni hin argamne."
        });
      }

      const exam = examResult.rows[0];

      const result = await pool.query(
        `
        SELECT
          id,
          student_name,
          details,
          score,
          total_points,
          correct_answers,
          wrong_answers,
          submitted_at
        FROM results
        WHERE exam_id = $1
        ORDER BY submitted_at DESC
        `,
        [exam.id]
      );

      const results =
        result.rows.map(r => ({
          id: r.id,
          studentName: r.student_name,
          score: r.score,
          totalPoints: r.total_points,
          percentage:
            r.total_points > 0
              ? Math.round(
                  (r.score /
                    r.total_points) *
                    100
                )
              : 0,
          correctAnswers:
            r.correct_answers,
          wrongAnswers:
            r.wrong_answers,
          submittedAt:
            r.submitted_at,
          details:
            Array.isArray(r.details)
              ? r.details
              : []
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
        totalStudents:
          results.length,
        results
      });
    } catch (error) {
      console.error("RESULTS ERROR:", error);

      res.status(500).json({
        success: false,
        error:
          "Bu'aa argachuu hin dandeenye."
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
      const result = await pool.query(
        `
        SELECT
          r.*,
          e.code,
          e.title,
          e.subject,
          e.grade,
          e.teacher_name,
          e.questions
        FROM results r
        JOIN exams e
          ON e.id = r.exam_id
        WHERE r.id = $1
        `,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Bu'aan hin argamne."
        });
      }

      const r = result.rows[0];

      const details =
        Array.isArray(r.details)
          ? r.details
          : [];

      res.json({
        success: true,
        id: r.id,
        examCode: r.code,
        examTitle: r.title,
        subject: r.subject,
        grade: r.grade,
        teacherName:
          r.teacher_name,
        studentName:
          r.student_name,
        score: r.score,
        totalPoints:
          r.total_points,
        percentage:
          r.total_points > 0
            ? Math.round(
                (r.score /
                  r.total_points) *
                  100
              )
            : 0,
        correctAnswers:
          r.correct_answers,
        wrongAnswers:
          r.wrong_answers,
        submittedAt:
          r.submitted_at,
        details
      });
    } catch (error) {
      console.error(
        "ONE RESULT ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Bu'aa argachuu hin dandeenye."
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
        req.params.code,
        20
      ).toUpperCase();

      const result = await pool.query(
        `
        DELETE FROM exams
        WHERE code = $1
        RETURNING id
        `,
        [code]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Qormaanni hin argamne."
        });
      }

      res.json({
        success: true,
        message: "Qormaanni haqameera."
      });
    } catch (error) {
      console.error(
        "DELETE EXAM ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Qormaata haquu hin dandeenye."
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
// START
// ===============================

async function start() {
  try {
    console.log(
      "Database initialization started..."
    );

    await initDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `OR server running on port ${PORT}`
        );

        console.log(
          "Render PostgreSQL connected."
        );
      }
    );
  } catch (error) {
    console.error(
      "Server startup failed:",
      error
    );

    process.exit(1);
  }
}

start();
