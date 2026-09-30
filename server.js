const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ SUPABASE_URL ykn SUPABASE_SERVICE_ROLE_KEY hin argamne.");
  process.exit(1);
}

if (!SUPABASE_URL.startsWith("https://")) {
  console.error("❌ SUPABASE_URL https:// ta'uu qaba.");
  process.exit(1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const headers = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json"
};

async function supabase(table, options = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}`;

  if (options.query) {
    url += `?${options.query}`;
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      ...headers,
      ...(options.returnData
        ? { Prefer: "return=representation" }
        : {})
    },
    body: options.body
      ? JSON.stringify(options.body)
      : undefined
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      typeof data === "string"
        ? data
        : data?.message ||
          data?.error ||
          JSON.stringify(data)
    );
  }

  return data;
}

function cleanCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

function makeId() {
  return `${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 10)}`;
}

/* =========================
   HEALTH
========================= */

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    app: "OR",
    message: "OR Qormaataa server hojjachaa jira."
  });
});

/* =========================
   CREATE EXAM
========================= */

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

    if (!teacherName || !title) {
      return res.status(400).json({
        success: false,
        message: "Maqaa barsiisaa fi maqaa qormaataa guuti."
      });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Gaaffiiwwan yoo xiqqaate tokko galchi."
      });
    }

    let code = makeCode();

    for (let i = 0; i < 10; i++) {
      const existing = await supabase("exams", {
        query: `select=id&code=eq.${code}&limit=1`
      });

      if (!existing || existing.length === 0) {
        break;
      }

      code = makeCode();
    }

    const examId = makeId();

    const exam = await supabase("exams", {
      method: "POST",
      returnData: true,
      body: {
        id: examId,
        teacher_name: teacherName.trim(),
        title: title.trim(),
        subject: subject ? subject.trim() : "",
        grade: grade ? grade.trim() : "",
        duration: Number(duration) || 30,
        code
      }
    });

    const examRow = Array.isArray(exam) ? exam[0] : exam;

    const questionRows = questions.map((q, index) => ({
      id: makeId(),
      exam_id: examId,
      question_no: index + 1,
      question: String(q.question || "").trim(),
      type: q.type === "truefalse"
        ? "truefalse"
        : "multiple",
      option_a: q.option_a || "",
      option_b: q.option_b || "",
      option_c: q.option_c || "",
      option_d: q.option_d || "",
      correct_answer: String(q.correct_answer || "")
        .trim()
        .toUpperCase(),
      points: Number(q.points) || 1
    }));

    await supabase("questions", {
      method: "POST",
      body: questionRows
    });

    res.json({
      success: true,
      message: "Qormaanni milkaa'inaan uumame.",
      exam: {
        id: examRow.id,
        code: examRow.code,
        title: examRow.title,
        link: `/exam.html?code=${examRow.code}`
      }
    });
  } catch (error) {
    console.error("CREATE EXAM:", error);

    res.status(500).json({
      success: false,
      message: "Qormaata uumuu hin dandeenye.",
      error: error.message
    });
  }
});

/* =========================
   GET EXAM
========================= */

app.get("/api/exams/:code", async (req, res) => {
  try {
    const code = cleanCode(req.params.code);

    const exams = await supabase("exams", {
      query:
        `select=id,title,subject,grade,duration,code,teacher_name` +
        `&code=eq.${encodeURIComponent(code)}` +
        `&limit=1`
    });

    if (!exams || exams.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Qormaanni koodii kanaan hin argamne."
      });
    }

    const exam = exams[0];

    const questions = await supabase("questions", {
      query:
        `select=id,question_no,question,type,option_a,option_b,option_c,option_d,points` +
        `&exam_id=eq.${encodeURIComponent(exam.id)}` +
        `&order=question_no.asc`
    });

    res.json({
      success: true,
      exam,
      questions
    });
  } catch (error) {
    console.error("GET EXAM:", error);

    res.status(500).json({
      success: false,
      message: "Qormaata furuun hin danda'amne.",
      error: error.message
    });
  }
});

/* =========================
   SUBMIT EXAM
========================= */

app.post("/api/exams/:code/submit", async (req, res) => {
  try {
    const code = cleanCode(req.params.code);

    const {
      studentName,
      answers
    } = req.body;

    if (!studentName || !studentName.trim()) {
      return res.status(400).json({
        success: false,
        message: "Maqaa barataa galchi."
      });
    }

    const exams = await supabase("exams", {
      query:
        `select=id,title,code` +
        `&code=eq.${encodeURIComponent(code)}` +
        `&limit=1`
    });

    if (!exams || exams.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Qormaanni hin argamne."
      });
    }

    const exam = exams[0];

    const questions = await supabase("questions", {
      query:
        `select=id,question_no,correct_answer,points` +
        `&exam_id=eq.${encodeURIComponent(exam.id)}` +
        `&order=question_no.asc`
    });

    const givenAnswers =
      answers && typeof answers === "object"
        ? answers
        : {};

    let totalPoints = 0;
    let earnedPoints = 0;
    let correctCount = 0;
    let wrongCount = 0;
    let unansweredCount = 0;

    const answerRows = [];

    for (const q of questions) {
      const studentAnswer = String(
        givenAnswers[q.id] || ""
      )
        .trim()
        .toUpperCase();

      const correctAnswer = String(
        q.correct_answer || ""
      )
        .trim()
        .toUpperCase();

      const points = Number(q.points) || 1;

      totalPoints += points;

      let result = "unanswered";

      if (!studentAnswer) {
        unansweredCount++;
      } else if (studentAnswer === correctAnswer) {
        result = "correct";
        correctCount++;
        earnedPoints += points;
      } else {
        result = "wrong";
        wrongCount++;
      }

      answerRows.push({
        id: makeId(),
        exam_id: exam.id,
        question_id: q.id,
        student_name: studentName.trim(),
        student_answer: studentAnswer,
        correct_answer: correctAnswer,
        result,
        points: result === "correct" ? points : 0
      });
    }

    if (answerRows.length > 0) {
      await supabase("student_answers", {
        method: "POST",
        body: answerRows
      });
    }

    const percentage =
      totalPoints > 0
        ? Math.round((earnedPoints / totalPoints) * 100)
        : 0;

    const resultRow = await supabase("results", {
      method: "POST",
      returnData: true,
      body: {
        id: makeId(),
        exam_id: exam.id,
        student_name: studentName.trim(),
        total_questions: questions.length,
        correct_count: correctCount,
        wrong_count: wrongCount,
        unanswered_count: unansweredCount,
        total_points: totalPoints,
        earned_points: earnedPoints,
        percentage
      }
    });

    res.json({
      success: true,
      message: "Qormaanni xumurame.",
      result: {
        examTitle: exam.title,
        studentName: studentName.trim(),
        totalQuestions: questions.length,
        correct: correctCount,
        wrong: wrongCount,
        unanswered: unansweredCount,
        totalPoints,
        earnedPoints,
        percentage
      }
    });
  } catch (error) {
    console.error("SUBMIT EXAM:", error);

    res.status(500).json({
      success: false,
      message: "Deebii qormaataa galchuu hin dandeenye.",
      error: error.message
    });
  }
});

/* =========================
   TEACHER RESULTS
========================= */

app.get("/api/exams/:code/results", async (req, res) => {
  try {
    const code = cleanCode(req.params.code);

    const exams = await supabase("exams", {
      query:
        `select=id,title,teacher_name,code` +
        `&code=eq.${encodeURIComponent(code)}` +
        `&limit=1`
    });

    if (!exams || exams.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Qormaata hin argamne."
      });
    }

    const exam = exams[0];

    const results = await supabase("results", {
      query:
        `select=id,student_name,total_questions,correct_count,wrong_count,unanswered_count,total_points,earned_points,percentage,created_at` +
        `&exam_id=eq.${encodeURIComponent(exam.id)}` +
        `&order=created_at.desc`
    });

    res.json({
      success: true,
      exam,
      results
    });
  } catch (error) {
    console.error("RESULTS:", error);

    res.status(500).json({
      success: false,
      message: "Bu'aa qormaataa argachuu hin dandeenye.",
      error: error.message
    });
  }
});

/* =========================
   TEACHER ANSWERS
========================= */

app.get(
  "/api/exams/:code/student/:studentName",
  async (req, res) => {
    try {
      const code = cleanCode(req.params.code);
      const studentName = req.params.studentName;

      const exams = await supabase("exams", {
        query:
          `select=id,title,code` +
          `&code=eq.${encodeURIComponent(code)}` +
          `&limit=1`
      });

      if (!exams || exams.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Qormaata hin argamne."
        });
      }

      const exam = exams[0];

      const answers = await supabase("student_answers", {
        query:
          `select=question_id,student_answer,correct_answer,result,points` +
          `&exam_id=eq.${encodeURIComponent(exam.id)}` +
          `&student_name=eq.${encodeURIComponent(studentName)}` +
          `&order=id.asc`
      });

      res.json({
        success: true,
        exam,
        studentName,
        answers
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Deebii barataa argachuu hin dandeenye.",
        error: error.message
      });
    }
  }
);

/* =========================
   FRONTEND
========================= */

app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ OR server running on port ${PORT}`);
});
