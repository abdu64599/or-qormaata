const express = require("express");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// =====================================
// RENDER POSTGRESQL
// =====================================

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL hin argamne.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// =====================================
// DATABASE
// =====================================

async function initDatabase() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // EXAMS
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

    // RESULTS
    await client.query(`
      CREATE TABLE IF NOT EXISTS results (
        id UUID PRIMARY KEY,
        exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
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

    // Yoo results table duraan ture ta'e,
    // details column ni dabala.
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

// =====================================
// HELPERS
// =====================================

function text(value, max = 500) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value)
    .trim()
    .slice(0, max);
}

async function createUniqueCode() {
  for (let i = 0; i < 20; i++) {
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

// =====================================
// STATUS
// =====================================

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
    console.error("STATUS:", error);

    res.status(500).json({
      success: false,
      status: "offline"
    });
  }
});

// =====================================
// CREATE EXAM
// =====================================

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

    if (!text(teacherName)) {
      return res.status(400).json({
        success: false,
        message: "Maqaa barsiisaa galchi."
      });
    }

    if (!text(title)) {
      return res.status(400).json({
        success: false,
        message: "Mata duree qormaataa galchi."
      });
    }

    if (
      !Array.isArray(questions) ||
      questions.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Yoo xiqqaate gaaffii tokko galchi."
      });
    }

    const cleanQuestions = questions.map((q, index) => {
      const type =
        q.type === "truefalse"
          ? "truefalse"
          : "multiple";

      let options;

      if (type === "truefalse") {
        options = ["Dhugaa", "Soba"];
      } else {
        options = Array.isArray(q.options)
          ? q.options
              .map(x => text(x, 500))
              .filter(Boolean)
              .slice(0, 4)
          : [];
      }

      let answer = text(q.answer, 500);

      // True / False sirreessi
      if (type === "truefalse") {
        const lower = answer.toLowerCase();

        if (
          lower === "dhugaa" ||
          lower === "true"
        ) {
          answer = "Dhugaa";
        } else if (
          lower === "soba" ||
          lower === "false"
        ) {
          answer = "Soba";
        }
      }

      return {
        id: q.id || crypto.randomUUID(),

        number: index + 1,

        type,

        question: text(
          q.question,
          2000
        ),

        options,

        answer,

        points:
          Number(q.points) > 0
            ? Number(q.points)
            : 1
      };
    });

    // =================================
    // VALIDATION
    // =================================

    for (const q of cleanQuestions) {
      if (!q.question) {
        return res.status(400).json({
          success: false,
          message:
            `Gaaffii ${q.number} guuti.`
        });
      }

      if (!q.answer) {
        return res.status(400).json({
          success: false,
          message:
            `Deebii sirrii gaaffii ${q.number} galchi.`
        });
      }

      if (
        q.type === "multiple" &&
        q.options.length < 2
      ) {
        return res.status(400).json({
          success: false,
          message:
            `Gaaffii ${q.number} filannoo qabaachuu qaba.`
        });
      }

      // Multiple choice keessatti
      // answer filannoo keessaa ta'uu qaba.
      if (
        q.type === "multiple" &&
        !q.options.some(
          option =>
            option.trim().toLowerCase() ===
            q.answer.trim().toLowerCase()
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            `Deebiin sirrii gaaffii ${q.number} filannoo keessaa ta'uu qaba.`
        });
      }

      // True/False validation
      if (
        q.type === "truefalse" &&
        !["Dhugaa", "Soba"].includes(q.answer)
      ) {
        return res.status(400).json({
          success: false,
          message:
            `Gaaffii ${q.number}: Dhugaa ykn Soba filadhu.`
        });
      }
    }

    const id = crypto.randomUUID();

    const code =
      await createUniqueCode();

    const result =
      await pool.query(
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
          title,
          teacher_name,
          subject,
          grade,
          duration,
          created_at
        `,
        [
          id,
          code,
          text(title, 250),
          text(teacherName, 150),
          text(subject, 150),
          text(grade, 100),
          Number(duration) > 0
            ? Number(duration)
            : 30,
          JSON.stringify(cleanQuestions)
        ]
      );

    const baseUrl =
      `${req.protocol}://${req.get("host")}`;

    res.status(201).json({
      success: true,

      message:
        "Qormaanni uumameera.",

      exam:
        result.rows[0],

      link:
        `${baseUrl}/?exam=${code}`
    });

  } catch (error) {
    console.error(
      "CREATE EXAM:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Qormaata uumuu irratti rakkoon uumame."
    });
  }
});

// =====================================
// GET EXAM
// =====================================

app.get(
  "/api/exams/:code",
  async (req, res) => {
    try {
      const code =
        text(
          req.params.code,
          20
        ).toUpperCase();

      const result =
        await pool.query(
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

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message:
            "Qormaanni kun hin argamne."
        });
      }

      const exam =
        result.rows[0];

      // Studentf answer hin erginu.
      const questions =
        exam.questions.map(q => ({
          id: q.id,
          number: q.number,
          type: q.type,
          question: q.question,
          options: q.options,
          points: q.points
        }));

      res.json({
        success: true,

        exam: {
          id: exam.id,
          code: exam.code,
          teacherName:
            exam.teacher_name,
          title: exam.title,
          subject: exam.subject,
          grade: exam.grade,
          duration: exam.duration,
          questions
        }
      });

    } catch (error) {
      console.error(
        "GET EXAM:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Qormaata furuun hin danda'amne."
      });
    }
  }
);

// =====================================
// SUBMIT EXAM
// =====================================

app.post(
  "/api/exams/:code/submit",
  async (req, res) => {
    try {
      const code =
        text(
          req.params.code,
          20
        ).toUpperCase();

      const studentName =
        text(
          req.body.studentName,
          150
        );

      const answers =
        req.body.answers;

      if (!studentName) {
        return res.status(400).json({
          success: false,
          message:
            "Maqaa barataa galchi."
        });
      }

      if (
        !answers ||
        typeof answers !== "object"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Deebiin qormaataa hin argamne."
        });
      }

      const examResult =
        await pool.query(
          `
          SELECT *
          FROM exams
          WHERE code = $1
          `,
          [code]
        );

      if (!examResult.rows.length) {
        return res.status(404).json({
          success: false,
          message:
            "Qormaanni hin argamne."
        });
      }

      const exam =
        examResult.rows[0];

      let score = 0;
      let totalPoints = 0;
      let correctAnswers = 0;
      let wrongAnswers = 0;

      const details = [];

      // =================================
      // GAaffii GAaffiidhaan QORII
      // =================================

      for (
        const q of exam.questions
      ) {
        const points =
          Number(q.points) || 1;

        totalPoints += points;

        const studentAnswer =
          answers[q.id] === undefined
            ? ""
            : String(
                answers[q.id]
              ).trim();

        const correctAnswer =
          String(
            q.answer || ""
          ).trim();

        const correct =
          studentAnswer
            .toLowerCase() ===
          correctAnswer
            .toLowerCase();

        if (correct) {
          score += points;
          correctAnswers++;
        } else {
          wrongAnswers++;
        }

        details.push({
          questionId: q.id,

          number: q.number,

          question:
            q.question,

          type:
            q.type,

          options:
            q.options,

          studentAnswer,

          correctAnswer,

          correct,

          earnedPoints:
            correct ? points : 0,

          maxPoints:
            points
        });
      }

      const resultId =
        crypto.randomUUID();

      // =================================
      // RESULT + DETAILS KUUSI
      // =================================

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
              (score /
                totalPoints) *
              100
            )
          : 0;

      res.json({
        success: true,

        message:
          "Qormaanni xumurameera.",

        result: {
          id: resultId,

          examCode:
            exam.code,

          examTitle:
            exam.title,

          studentName,

          score,

          totalPoints,

          percentage,

          correctAnswers,

          wrongAnswers,

          totalQuestions:
            exam.questions.length,

          // ⭐ GAaffii hundaa
          details
        }
      });

    } catch (error) {
      console.error(
        "SUBMIT:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Qormaata erguu irratti rakkoon uumame."
      });
    }
  }
);

// =====================================
// TEACHER RESULTS
// =====================================

app.get(
  "/api/exams/:code/results",
  async (req, res) => {
    try {
      const code =
        text(
          req.params.code,
          20
        ).toUpperCase();

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
          WHERE code = $1
          `,
          [code]
        );

      if (!examResult.rows.length) {
        return res.status(404).json({
          success: false,
          message:
            "Qormaanni hin argamne."
        });
      }

      const exam =
        examResult.rows[0];

      // ⭐ DETAILS Dabalatee fida
      const results =
        await pool.query(
          `
          SELECT
            id,
            student_name,
            answers,
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

      const data =
        results.rows.map(r => ({
          id: r.id,

          studentName:
            r.student_name,

          score:
            r.score,

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

          // ⭐ Kun baay'ee barbaachisaa dha
          details:
            Array.isArray(r.details)
              ? r.details
              : []
        }));

      res.json({
        success: true,

        exam,

        totalStudents:
          data.length,

        results:
          data
      });

    } catch (error) {
      console.error(
        "RESULTS:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Bu'aa argachuu hin dandeenye."
      });
    }
  }
);

// =====================================
// ONE RESULT
// =====================================

app.get(
  "/api/results/:id",
  async (req, res) => {
    try {
      const result =
        await pool.query(
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

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message:
            "Bu'aan hin argamne."
        });
      }

      const r =
        result.rows[0];

      // Details duraan kuufame fayyadami.
      // Yoo hin jirre, deebisanii shallagi.
      let details =
        Array.isArray(r.details)
          ? r.details
          : [];

      if (details.length === 0) {
        details =
          r.questions.map(q => {
            const studentAnswer =
              r.answers?.[q.id] || "";

            const correct =
              String(
                studentAnswer
              )
                .trim()
                .toLowerCase() ===
              String(
                q.answer
              )
                .trim()
                .toLowerCase();

            return {
              questionId: q.id,

              number: q.number,

              question:
                q.question,

              type:
                q.type,

              options:
                q.options,

              studentAnswer,

              correctAnswer:
                q.answer,

              correct,

              earnedPoints:
                correct
                  ? q.points
                  : 0,

              maxPoints:
                q.points
            };
          });
      }

      res.json({
        success: true,

        result: {
          id: r.id,

          examCode:
            r.code,

          examTitle:
            r.title,

          subject:
            r.subject,

          grade:
            r.grade,

          teacherName:
            r.teacher_name,

          studentName:
            r.student_name,

          score:
            r.score,

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
        }
      });

    } catch (error) {
      console.error(
        "ONE RESULT:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Bu'aa argachuu hin dandeenye."
      });
    }
  }
);

// =====================================
// DELETE EXAM
// =====================================

app.delete(
  "/api/exams/:code",
  async (req, res) => {
    try {
      const code =
        text(
          req.params.code,
          20
        ).toUpperCase();

      const result =
        await pool.query(
          `
          DELETE FROM exams
          WHERE code = $1
          RETURNING id
          `,
          [code]
        );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message:
            "Qormaanni hin argamne."
        });
      }

      res.json({
        success: true,
        message:
          "Qormaanni haqameera."
      });

    } catch (error) {
      console.error(
        "DELETE:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Qormaata haquu hin dandeenye."
      });
    }
  }
);

// =====================================
// FRONTEND
// =====================================

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
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

// =====================================
// START SERVER
// =====================================

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
