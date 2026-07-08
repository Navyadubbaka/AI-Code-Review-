require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const OpenAI = require("openai");

const app = express();
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PORT = process.env.PORT || 5000;

// Keep raw body for GitHub signature verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// ── Verify the request came from GitHub ─────────────────
function verifyGithubSignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ── Fetch the PR diff from GitHub ───────────────────────
async function getPrDiff(repoFullName, prNumber) {
  const response = await axios.get(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3.diff",
      },
    },
  );
  return response.data;
}

// ── Send the diff to GPT-4o ──────────────────────────────
async function reviewWithOpenAI(diff, prTitle) {
  const response = await openai.chat.completions.create({
    // Use a supported model. `llama3-70b-8192` was decommissioned.
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are a senior software engineer reviewing a pull request.
Be direct, specific, and constructive. Point to exact lines when possible.
Format your review in clean markdown.`,
      },
      {
        role: "user",
        content: `PR Title: ${prTitle}

Please review this diff and provide:

## 1. Summary
What does this PR do?

## 2. Bugs / Logic Errors
Any issues that would break functionality?

## 3. Code Quality
Readability, naming, structure, duplication?

## 4. Security Concerns
Any vulnerabilities, exposed secrets, injection risks?

## 5. Verdict
One of: ✅ Approve | 🔄 Request Changes | 💬 Needs Discussion

---
Diff:
${diff.slice(0, 7000)}`,
      },
    ],
  });
  return response.choices[0].message.content;
}

// ── Post the review as a PR comment ─────────────────────
async function postPrComment(repoFullName, prNumber, review) {
  const response = await axios.post(
    `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`,
    { body: `## 🤖 AI Code Review (GPT-4o)\n\n${review}` },
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
    },
  );
  return response.status;
}

// ── Webhook route ────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  if (!verifyGithubSignature(req)) {
    console.log("❌ Invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.headers["x-github-event"];
  const payload = req.body;

  if (event !== "pull_request") {
    return res.json({ status: `Ignored event: ${event}` });
  }

  const action = payload.action;
  if (!["opened", "synchronize"].includes(action)) {
    return res.json({ status: `Ignored action: ${action}` });
  }

  const repo = payload.repository.full_name;
  const prNumber = payload.pull_request.number;
  const prTitle = payload.pull_request.title;
  const author = payload.pull_request.user.login;

  console.log(`\n📥 PR #${prNumber} by @${author}: "${prTitle}"`);

  try {
    console.log("   Fetching diff...");
    const diff = await getPrDiff(repo, prNumber);

    if (!diff || diff.length < 10) {
      return res.json({ status: "Empty diff, skipped" });
    }

    console.log("   Sending to GPT-4o...");
    const review = await reviewWithOpenAI(diff, prTitle);

    console.log("   Posting comment to GitHub...");
    const status = await postPrComment(repo, prNumber, review);

    console.log(`   ✅ Done! Comment posted (HTTP ${status})\n`);
    return res.json({ status: "reviewed", pr: prNumber });
  } catch (err) {
    console.error("   ❌ Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "AI Reviewer is running ✅" });
});
// const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 AI Reviewer running on http://localhost:${PORT}`);
  console.log(`   Webhook endpoint: http://localhost:${PORT}/webhook`);
});
