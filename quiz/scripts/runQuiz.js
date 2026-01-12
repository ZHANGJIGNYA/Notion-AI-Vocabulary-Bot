// quiz/scripts/runQuiz.js

async function getValidModel(apiKey) {
  console.log("🔍 Auto-detecting available Gemini models...");
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    if (!resp.ok) {
      console.error("❌ Failed to list models. Status:", resp.status);
      return null;
    }
    const data = await resp.json();

    // 找到所有支持 'generateContent' 的模型
    const candidates = data.models.filter(
      (m) =>
        m.supportedGenerationMethods &&
        m.supportedGenerationMethods.includes("generateContent")
    );

    if (candidates.length === 0) return null;

    // 优先找 Flash (速度快)，其次找 Pro，最后随便拿一个
    let chosen = candidates.find((m) => m.name.includes("flash"));
    if (!chosen) chosen = candidates.find((m) => m.name.includes("pro"));
    if (!chosen) chosen = candidates[0];

    // API 返回的名字通常是 "models/gemini-1.5-flash"，我们需要去掉前缀吗？
    // 其实 generateContent 的 URL 格式是 /models/{model}:generateContent
    // 如果 name 本身就是 "models/..."，那我们提取后面的部分，或者直接拼 URL 时注意一下

    // 这里的 chosen.name 通常是 "models/gemini-1.5-flash"
    console.log(`✅ Auto-selected model: ${chosen.name}`);
    return chosen.name; // 返回完整名字，例如 models/gemini-1.5-flash
  } catch (e) {
    console.error("❌ Model detection failed:", e);
    return null;
  }
}

async function main() {
  try {
    console.log(
      "🚀 Starting MCQ Quiz Generation (Auto-Model-Discovery Mode)..."
    );

    const databaseId = process.env.NOTION_DB_ID;
    const notionToken = process.env.NOTION_TOKEN;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!databaseId || !notionToken || !geminiApiKey) {
      throw new Error("❌ Missing Environment Variables!");
    }

    // --- 🤖 第一步：自动寻找可用的模型名字 ---
    const modelFullName = await getValidModel(geminiApiKey);
    if (!modelFullName) {
      throw new Error(
        "❌ No valid Gemini models found for this API Key. Check your Google AI Studio account."
      );
    }
    // modelFullName 类似 "models/gemini-1.5-flash"

    // --- 第二步：筛选 Notion ---
    const queryResp = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          page_size: 50,
          filter: {
            or: [
              { property: "Last Quiz", date: { is_empty: true } },
              { property: "Quiz Due", checkbox: { equals: true } },
            ],
          },
        }),
      }
    );

    const data = await queryResp.json();
    let wordsToQuiz = data.results || [];

    // 日期过滤
    const todayStr = new Date().toISOString().split("T")[0];

    body: JSON.stringify({
      properties: {
        Question: {
          rich_text: [{ text: { content: finalQuestion } }],
        },
        "Answer Key": {
          rich_text: [{ text: { content: correctLabel } }],
        },
        "My Answer": {
          rich_text: [],
        },
        "Last Quiz": {
          date: { start: todayStr },
        },
        "Quiz Due": {
          checkbox: false,
        },
      },
    });

    wordsToQuiz.sort(() => 0.5 - Math.random());

    if (wordsToQuiz.length === 0) {
      console.log("✅ No words need quizzing today.");
      return;
    }

    console.log(`📝 Processing ${wordsToQuiz.length} words...`);

    // --- 第三步：循环出题 ---
    for (const page of wordsToQuiz) {
      // ===== 1. 取单词 =====
      let word = null;
      const nameProp = page.properties["Name"];
      if (nameProp && nameProp.title && nameProp.title.length > 0) {
        word = nameProp.title[0].plain_text;
      }
      if (!word) continue;

      console.log(`🧠 Generating quiz for "${word}"`);

      // ===== 2. 生成 prompt =====
      const quizTypes = ["sentence", "definition", "thesaurus"];
      const selectedType =
        quizTypes[Math.floor(Math.random() * quizTypes.length)];

      const prompt = `Generate ONE multiple-choice question for the word "${word}".
Type: ${selectedType}.
Return ONLY valid JSON. No markdown. No extra text.

Schema:
{"q":"question","a":"${word}","w":["wrong1","wrong2","wrong3"]}`;

      // ===== 3. 调用 Gemini =====
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/${modelFullName}:generateContent?key=${geminiApiKey}`;

      const geminiResp = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      });

      if (!geminiResp.ok) {
        console.error("❌ Gemini API error:", await geminiResp.text());
        continue;
      }

      const gData = await geminiResp.json();
      if (!gData.candidates || gData.candidates.length === 0) {
        console.error("❌ Gemini returned no candidates");
        continue;
      }

      // ===== 4. 解析 JSON =====
      let quizData;
      try {
        const aiText = gData.candidates[0].content.parts[0].text;
        const start = aiText.indexOf("{");
        const end = aiText.lastIndexOf("}");
        quizData = JSON.parse(aiText.slice(start, end + 1));
      } catch (e) {
        console.error("⚠️ JSON parse failed, fallback");
        quizData = {
          q: `Choose the correct answer for "${word}".`,
          a: word,
          w: ["Option A", "Option B", "Option C"],
        };
      }

      // ===== 5. 生成选项 =====
      const questionText =
        quizData.q || `Choose the correct answer for "${word}".`;
      const correctAnswer = quizData.a || word;
      let distractors = Array.isArray(quizData.w) ? quizData.w.slice(0, 3) : [];

      while (distractors.length < 3) distractors.push("Option X");

      let options = [
        { text: correctAnswer, isCorrect: true },
        { text: distractors[0], isCorrect: false },
        { text: distractors[1], isCorrect: false },
        { text: distractors[2], isCorrect: false },
      ];

      options.sort(() => Math.random() - 0.5);

      // ===== 6. 拼 finalQuestion（重点）=====
      const labels = ["A", "B", "C", "D"];
      let finalQuestion = questionText + "\n\n";
      let correctLabel = "";

      options.forEach((opt, idx) => {
        const label = labels[idx];
        finalQuestion += `${label}. ${opt.text}\n`;
        if (opt.isCorrect) correctLabel = label;
      });

      // ===== 7. 写回 Notion（只此一处 PATCH）=====
      const todayStr = new Date().toISOString().split("T")[0];

      const updateResp = await fetch(
        `https://api.notion.com/v1/pages/${page.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${notionToken}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            properties: {
              Question: { rich_text: [{ text: { content: finalQuestion } }] },
              "Answer Key": {
                rich_text: [{ text: { content: correctLabel } }],
              },
              "My Answer": { rich_text: [] },
              "Last Quiz": { date: { start: todayStr } },
              "Quiz Due": { checkbox: false },
            },
          }),
        }
      );

      if (!updateResp.ok) {
        console.error("❌ Notion update failed:", await updateResp.text());
      } else {
        console.log(`✅ Quiz generated for "${word}" (Ans: ${correctLabel})`);
      }
    }

    console.log("🎉 All Done!");
  } catch (err) {
    console.error("❌ Fatal Error:", err);
    process.exit(1);
  }
}

main();
