const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================================
   DATABASE
========================================= */

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

  connectionTimeoutMillis: 10000
});

/* =========================================
   HELPERS
========================================= */

function cleanText(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

function normalizeOptions(options) {
  if (Array.isArray(options)) {
    return options
      .map((value) => cleanText(value))
      .filter(Boolean);
  }

  if (options && typeof options === "object") {
    return [
      options.A,
      options.B,
      options.C,
      options.D
    ]
      .map((value) => cleanText(value))
      .filter(Boolean);
  }

  return [];
}

function getOptionLetter(index) {
  const letters = ["A", "B", "C", "D"];

  return letters[index] || String(index + 1);
}

function normalizeCorrectAnswer(question) {
  const type = cleanText(question.type).toLowerCase();

  let answer = cleanText(
    question.correctAnswer ?? question.answer
  );

  if (!answer) {
    return "";
  }

  /* TRUE / FALSE */

  if (
    type === "truefalse" ||
    type === "true_false" ||
    type === "boolean" ||
    type.includes("true")
  ) {
    const lower = answer.toLowerCase();

    if (
      lower === "a" ||
      lower === "dhugaa" ||
      lower === "true" ||
      lower === "dhugaa dha"
    ) {
      return "Dhugaa";
    }

    if (
      lower === "b" ||
      lower === "soba" ||
      lower === "false" ||
      lower === "soba dha"
    ) {
      return "Soba";
    }

    return answer;
  }

  /* MULTIPLE CHOICE */

  const options = normalizeOptions(question.options);

  const letters = ["A", "B", "C", "D"];

  const upper = answer.toUpperCase();

  let letterIndex = letters.indexOf(upper);

  if (
    letterIndex >= 0 &&
    options[letterIndex] !== undefined
  ) {
    return options[letterIndex];
  }

  /* A) / A. */

  const firstChar = answer
    .replace(/[.)]/g, "")
    .trim()
    .charAt(0)
    .toUpperCase();

  letterIndex = letters.indexOf(firstChar);

  if (
    letterIndex >= 0 &&
    options[letterIndex] !== undefined
  ) {
    return options[letterIndex];
  }

  return answer;
}

function normalizeQuestion(question, index) {
  const type =
    cleanText(question.type).toLowerCase() ||
    "multiple";

  return {
    id:
      cleanText(question.id) ||
      `q_${Date.now()}_${index}_${Math.random()
        .toString(36)
        .slice(2, 7)}`,

    question: cleanText(
      question.question ??
      question.questionText
    ),

    type: type,

    options: normalizeOptions(
      question.options
    ),

    correctAnswer: normalizeCorrectAnswer(
      question
    ),

    points: Number(question.points) || 1
  };
}

function parseQuestions(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);

      return Array.isArray(parsed)
        ? parsed
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function parseDetails(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);

      return Array.isArray(parsed)
        ? parsed
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

/* =========================================
   EXAM CODE
========================================= */

function generateExamCode() {
  return (
    "OR" +
    crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase()
  );
}

async function createUniqueExamCode() {
  for (let i = 0; i < 20; i++) {
    const code = generateExamCode();

    const result = await pool.query(
      `SELECT id FROM exams WHERE code = $1 LIMIT 1`,
      [code]
    );

    if (result.rows.length === 0) {
      return code;
    }
  }

  throw new Error(
    "Koodii qormaataa uumuu hin dandeenye."
  );
}

/* =========================================
   DATABASE INIT / MIGRATION
========================================= */

async function initDatabase() {
  console.log("Database initialization started...");

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL Render keessatti hin argamne."
    );
  }

  /* EXAMS */

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
    );
  `);

  /* RESULTS */

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
    );
  `);

  /*
    DATABASE duraan jiraachuu danda'a.
    Yoo exam_code hin jirre itti dabala.
  */

  await pool.query(`
    ALTER TABLE results
    ADD COLUMN IF NOT EXISTS exam_code VARCHAR(30);
  `);

  /*
    Results duraan jiran irraa exam_code guuta.
  */

  await pool.query(`
    UPDATE results r
    SET exam_code = e.code
    FROM exams e
    WHERE r.exam_id = e.id
      AND (
        r.exam_code IS NULL
        OR TRIM(r.exam_code) = ''
      );
  `);

  /*
    Index exams
  */

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_exams_code
    ON exams(code);
  `);

  /*
    Index results exam_id
  */

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_results_exam_id
    ON results(exam_id);
  `);

  /*
    Index results exam_code.
    Amma column jiraachuu isaa mirkaneessinee booda.
  */

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_results_exam_code
    ON results(exam_code);
  `);

  /*
    Index submitted_at
  */

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_results_submitted_at
    ON results(submitted_at);
  `);

  console.log(
    "Database migrations completed."
  );
}

/* =========================================
   STATUS
========================================= */

app.get(
  "/api/status",
  async function (req, res) {
    try {
      await pool.query("SELECT 1");

      res.json({
        success: true,
        app: "OR - Sirna Qormaataa Barattootaa",
        status: "online",
        database: "connected",
        time: new Date().toISOString()
      });
    } catch (error) {
      console.error(
        "STATUS ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        app: "OR - Sirna Qormaataa Barattootaa",
        status: "online",
        database: "error",
        error: error.message
      });
    }
  }
);

/* =========================================
   CREATE EXAM
========================================= */

app.post(
  "/api/exams",
  async function (req, res) {
    try {
      const {
        teacherName,
        title,
        subject,
        grade,
        duration,
        questions
      } = req.body;

      const teacher = cleanText(
        teacherName
      );

      const examTitle = cleanText(
        title
      );

      const examSubject = cleanText(
        subject
      );

      const examGrade = cleanText(
        grade
      );

      const examDuration =
        Number(duration) || 30;

      if (!teacher) {
        return res.status(400).json({
          success: false,
          error:
            "Maqaa barsiisaa galchi."
        });
      }

      if (!examTitle) {
        return res.status(400).json({
          success: false,
          error:
            "Mata-duree qormaataa galchi."
        });
      }

      if (!examSubject) {
        return res.status(400).json({
          success: false,
          error:
            "Barnoota galchi."
        });
      }

      if (!examGrade) {
        return res.status(400).json({
          success: false,
          error:
            "Kutaa galchi."
        });
      }

      if (
        !Array.isArray(questions) ||
        questions.length === 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Yoo xiqqaate gaaffii tokko galchi."
        });
      }

      const normalizedQuestions =
        questions.map(
          function (question, index) {
            return normalizeQuestion(
              question,
              index
            );
          }
        );

      for (
        let i = 0;
        i < normalizedQuestions.length;
        i++
      ) {
        const q =
          normalizedQuestions[i];

        if (!q.question) {
          return res.status(400).json({
            success: false,
            error:
              `Gaaffii ${i + 1} keessatti barruun gaaffii jiraachuu qaba.`
          });
        }

        if (!q.correctAnswer) {
          return res.status(400).json({
            success: false,
            error:
              `Gaaffii ${i + 1} keessatti deebiin sirrii hin jiru.`
          });
        }

        if (
          q.options.length < 2
        ) {
          return res.status(400).json({
            success: false,
            error:
              `Gaaffii ${i + 1} keessatti filannoon gahaan hin jiru.`
          });
        }
      }

      const code =
        await createUniqueExamCode();

      const result =
        await pool.query(
          `
          INSERT INTO exams (
            code,
            teacher_name,
            title,
            subject,
            grade,
            duration,
            questions
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7
          )
          RETURNING *
          `,
          [
            code,
            teacher,
            examTitle,
            examSubject,
            examGrade,
            examDuration,
            JSON.stringify(
              normalizedQuestions
            )
          ]
        );

      const exam =
        result.rows[0];

      const link =
        `${req.protocol}://${req.get(
          "host"
        )}/?exam=${encodeURIComponent(
          code
        )}`;

      res.status(201).json({
        success: true,

        message:
          "Qormaanni milkaa'inaan uumameera.",

        code: code,

        link: link,

        exam: {
          id: exam.id,
          code: exam.code,
          teacherName:
            exam.teacher_name,
          title: exam.title,
          subject: exam.subject,
          grade: exam.grade,
          duration: exam.duration,
          questions:
            normalizedQuestions
        }
      });
    } catch (error) {
      console.error(
        "CREATE EXAM ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Qormaata uumuu irratti rakkoon uumame: " +
          error.message
      });
    }
  }
);

/* =========================================
   GET EXAM
========================================= */

app.get(
  "/api/exams/:code",
  async function (req, res) {
    try {
      const code =
        cleanText(
          req.params.code
        ).toUpperCase();

      const result =
        await pool.query(
          `
          SELECT *
          FROM exams
          WHERE UPPER(code) = $1
          LIMIT 1
          `,
          [code]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          error:
            "Qormaanni koodii kana qabu hin argamne."
        });
      }

      const exam =
        result.rows[0];

      const questions =
        parseQuestions(
          exam.questions
        );

      res.json({
        success: true,

        id: exam.id,

        code: exam.code,

        teacherName:
          exam.teacher_name,

        title:
          exam.title,

        subject:
          exam.subject,

        grade:
          exam.grade,

        duration:
          exam.duration,

        questions:
          questions
      });
    } catch (error) {
      console.error(
        "GET EXAM ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Qormaata argachuu irratti rakkoon uumame: " +
          error.message
      });
    }
  }
);

/* =========================================
   SUBMIT EXAM
========================================= */

app.post(
  "/api/exams/:code/submit",
  async function (req, res) {
    try {
      const code =
        cleanText(
          req.params.code
        ).toUpperCase();

      const studentName =
        cleanText(
          req.body.studentName
        );

      const answers =
        req.body.answers;

      if (!studentName) {
        return res.status(400).json({
          success: false,
          error:
            "Maqaa barataa galchi."
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
          SELECT *
          FROM exams
          WHERE UPPER(code) = $1
          LIMIT 1
          `,
          [code]
        );

      if (
        examResult.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          error:
            "Qormaanni hin argamne."
        });
      }

      const exam =
        examResult.rows[0];

      const questions =
        parseQuestions(
          exam.questions
        );

      let score = 0;
      let totalPoints = 0;
      let correctAnswers = 0;
      let wrongAnswers = 0;

      const details = [];

      questions.forEach(
        function (q, index) {
          const points =
            Number(q.points) || 1;

          totalPoints += points;

          const questionId =
            String(q.id);

          let studentAnswer =
            answers[questionId];

          if (
            studentAnswer === undefined ||
            studentAnswer === null
          ) {
            studentAnswer = "";
          }

          studentAnswer =
            cleanText(
              studentAnswer
            );

          const options =
            normalizeOptions(
              q.options
            );

          /*
            A/B/C/D -> option text
          */

          const letters = [
            "A",
            "B",
            "C",
            "D"
          ];

          const selectedIndex =
            letters.indexOf(
              studentAnswer.toUpperCase()
            );

          if (
            selectedIndex >= 0 &&
            options[selectedIndex] !== undefined
          ) {
            studentAnswer =
              options[selectedIndex];
          }

          /*
            Correct answer
          */

          let correctAnswer =
            cleanText(
              q.correctAnswer ??
              q.correct_answer
            );

          /*
            Yoo correctAnswer
            A/B/C/D ta'e.
          */

          const correctIndex =
            letters.indexOf(
              correctAnswer.toUpperCase()
            );

          if (
            correctIndex >= 0 &&
            options[correctIndex] !== undefined
          ) {
            correctAnswer =
              options[correctIndex];
          }

          /*
            TRUE / FALSE
          */

          const type =
            String(
              q.type || ""
            ).toLowerCase();

          if (
            type.includes("true") ||
            type.includes("boolean")
          ) {
            const studentLower =
              studentAnswer.toLowerCase();

            const correctLower =
              correctAnswer.toLowerCase();

            if (
              studentLower === "a" ||
              studentLower === "true" ||
              studentLower === "dhugaa" ||
              studentLower === "dhugaa dha"
            ) {
              studentAnswer =
                "Dhugaa";
            }

            if (
              studentLower === "b" ||
              studentLower === "false" ||
              studentLower === "soba" ||
              studentLower === "soba dha"
            ) {
              studentAnswer =
                "Soba";
            }

            if (
              correctLower === "a" ||
              correctLower === "true" ||
              correctLower === "dhugaa" ||
              correctLower === "dhugaa dha"
            ) {
              correctAnswer =
                "Dhugaa";
            }

            if (
              correctLower === "b" ||
              correctLower === "false" ||
              correctLower === "soba" ||
              correctLower === "soba dha"
            ) {
              correctAnswer =
                "Soba";
            }
          }

          const studentCompare =
            studentAnswer
              .trim()
              .toLowerCase();

          const correctCompare =
            correctAnswer
              .trim()
              .toLowerCase();

          const isCorrect =
            studentAnswer !== "" &&
            studentCompare ===
              correctCompare;

          if (isCorrect) {
            score += points;
            correctAnswers++;
          } else {
            wrongAnswers++;
          }

          details.push({
            questionNumber:
              index + 1,

            questionId:
              questionId,

            question:
              q.question,

            options:
              options,

            studentAnswer:
              studentAnswer ||
              "Deebii hin kennamne",

            correctAnswer:
              correctAnswer,

            isCorrect:
              isCorrect,

            points:
              points,

            earnedPoints:
              isCorrect
                ? points
                : 0
          });
        }
      );

      const percentage =
        totalPoints > 0
          ? Number(
              (
                (score /
                  totalPoints) *
                100
              ).toFixed(2)
            )
          : 0;

      /*
        Save result
      */

      const insertResult =
        await pool.query(
          `
          INSERT INTO results (
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
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10
          )
          RETURNING *
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
        insertResult.rows[0];

      res.status(201).json({
        success: true,

        message:
          "Qormaanni kee milkaa'inaan ergameera.",

        id:
          saved.id,

        result: {
          id:
            saved.id,

          examCode:
            exam.code,

          examTitle:
            exam.title,

          studentName:
            saved.student_name,

          score:
            Number(saved.score),

          totalPoints:
            Number(
              saved.total_points
            ),

          percentage:
            Number(
              saved.percentage
            ),

          correctAnswers:
            Number(
              saved.correct_answers
            ),

          wrongAnswers:
            Number(
              saved.wrong_answers
            ),

          totalQuestions:
            Number(
              saved.total_questions
            ),

          details:
            details
        }
      });
    } catch (error) {
      console.error(
        "SUBMIT ERROR:",
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

/* =========================================
   GET ALL RESULTS
========================================= */

app.get(
  "/api/exams/:code/results",
  async function (req, res) {
    try {
      const code =
        cleanText(
          req.params.code
        ).toUpperCase();

      const examResult =
        await pool.query(
          `
          SELECT *
          FROM exams
          WHERE UPPER(code) = $1
          LIMIT 1
          `,
          [code]
        );

      if (
        examResult.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          error:
            "Qormaanni hin argamne."
        });
      }

      const exam =
        examResult.rows[0];

      /*
        exam_id fayyadamuun
        results barbaada.
        Kanaaf exam_code irratti
        rakkoo hin uumamu.
      */

      const resultsResult =
        await pool.query(
          `
          SELECT
            id,
            student_name,
            score,
            total_points,
            percentage,
            correct_answers,
            wrong_answers,
            total_questions,
            details,
            submitted_at
          FROM results
          WHERE exam_id = $1
          ORDER BY submitted_at DESC
          `,
          [exam.id]
        );

      const results =
        resultsResult.rows.map(
          function (row) {
            return {
              id:
                row.id,

              studentName:
                row.student_name,

              score:
                Number(row.score),

              totalPoints:
                Number(
                  row.total_points
                ),

              percentage:
                Number(
                  row.percentage
                ),

              correctAnswers:
                Number(
                  row.correct_answers
                ),

              wrongAnswers:
                Number(
                  row.wrong_answers
                ),

              totalQuestions:
                Number(
                  row.total_questions
                ),

              details:
                parseDetails(
                  row.details
                ),

              submittedAt:
                row.submitted_at
            };
          }
        );

      res.json({
        success: true,

        exam: {
          id:
            exam.id,

          code:
            exam.code,

          teacherName:
            exam.teacher_name,

          title:
            exam.title,

          subject:
            exam.subject,

          grade:
            exam.grade,

          duration:
            exam.duration
        },

        totalStudents:
          results.length,

        results:
          results
      });
    } catch (error) {
      console.error(
        "GET RESULTS ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Bu'aa argachuu irratti rakkoon uumame: " +
          error.message
      });
    }
  }
);

/* =========================================
   ONE STUDENT RESULT
========================================= */

app.get(
  "/api/results/:id",
  async function (req, res) {
    try {
      const id =
        Number(
          req.params.id
        );

      if (!id) {
        return res.status(400).json({
          success: false,
          error:
            "ID bu'aa sirrii miti."
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            r.*,
            e.title AS exam_title,
            e.subject AS exam_subject,
            e.grade AS exam_grade,
            e.teacher_name,
            e.code AS actual_exam_code

          FROM results r

          JOIN exams e
            ON e.id = r.exam_id

          WHERE r.id = $1

          LIMIT 1
          `,
          [id]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          error:
            "Bu'aan hin argamne."
        });
      }

      const row =
        result.rows[0];

      res.json({
        success: true,

        id:
          row.id,

        examCode:
          row.actual_exam_code,

        examTitle:
          row.exam_title,

        subject:
          row.exam_subject,

        grade:
          row.exam_grade,

        teacherName:
          row.teacher_name,

        studentName:
          row.student_name,

        score:
          Number(row.score),

        totalPoints:
          Number(
            row.total_points
          ),

        percentage:
          Number(
            row.percentage
          ),

        correctAnswers:
          Number(
            row.correct_answers
          ),

        wrongAnswers:
          Number(
            row.wrong_answers
          ),

        totalQuestions:
          Number(
            row.total_questions
          ),

        submittedAt:
          row.submitted_at,

        details:
          parseDetails(
            row.details
          )
      });
    } catch (error) {
      console.error(
        "GET ONE RESULT ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Bu'aa bal'aa argachuu hin dandeenye: " +
          error.message
      });
    }
  }
);

/* =========================================
   DELETE EXAM
========================================= */

app.delete(
  "/api/exams/:code",
  async function (req, res) {
    try {
      const code =
        cleanText(
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

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          error:
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
        "DELETE EXAM ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Qormaata haquu hin dandeenye: " +
          error.message
      });
    }
  }
);

/* =========================================
   FRONTEND
========================================= */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

app.get(
  "*",
  function (req, res) {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

/* =========================================
   ERROR HANDLER
========================================= */

app.use(
  function (
    error,
    req,
    res,
    next
  ) {
    console.error(
      "SERVER ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error:
        "Server irratti rakkoon uumame."
    });
  }
);

/* =========================================
   START SERVER
========================================= */

async function startServer() {
  try {
    await initDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      function () {
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
      "❌ Database initialization failed:",
      error
    );

    process.exit(1);
  }
}

startServer();
