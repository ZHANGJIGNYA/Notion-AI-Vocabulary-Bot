// quiz/scripts/runQuiz.js

async function getValidModel(apiKey) {
    console.log("🔍 Auto-detecting available Gemini models...");
    try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (!resp.ok) {
            console.error("❌ Failed to list models. Status:", resp.status);
            return null;
        }
        const data = await resp.json();

        // 找到所有支持 'generateContent' 的模型
        const candidates = data.models.filter(m =>
            m.supportedGenerationMethods &&
            m.supportedGenerationMethods.includes("generateContent")
        );

        if (candidates.length === 0) return null;

        // 优先找 Flash (速度快)，其次找 Pro，最后随便拿一个
        let chosen = candidates.find(m => m.name.includes("flash"));
        if (!chosen) chosen = candidates.find(m => m.name.includes("pro"));
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
        console.log("🚀 Starting MCQ Quiz Generation (Auto-Model-Discovery Mode)...");

        const databaseId = process.env.NOTION_DB_ID;
        const notionToken = process.env.NOTION_TOKEN;
        const geminiApiKey = process.env.GEMINI_API_KEY;

        if (!databaseId || !notionToken || !geminiApiKey) {
            throw new Error("❌ Missing Environment Variables!");
        }

        // --- 🤖 第一步：自动寻找可用的模型名字 ---
        const modelFullName = await getValidModel(geminiApiKey);
        if (!modelFullName) {
            throw new Error("❌ No valid Gemini models found for this API Key. Check your Google AI Studio account.");
        }
        // modelFullName 类似 "models/gemini-1.5-flash"

        // --- 第二步：筛选 Notion ---
        const queryResp = await fetch(
        `https://api.notion.com/v1/databases/${databaseId}/query`,
        {
            method: "POST",
            headers: {
            "Authorization": `Bearer ${notionToken}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
            },
            body: JSON.stringify({
            page_size: 50,
            filter: {
                or: [
                { property: "Last Quiz", date: { is_empty: true } },
                { property: "Quiz Due", checkbox: { equals: true } }
                ]
            }
            })
        }
        );

        const data = await queryResp.json();
        let wordsToQuiz = data.results || [];

        // 日期过滤
        const todayStr = new Date().toISOString().split("T")[0];

        body: JSON.stringify({
        properties: {
            "Question": {
            rich_text: [{ text: { content: finalQuestion } }]
            },
            "Answer Key": {
            rich_text: [{ text: { content: correctLabel } }]
            },
            "My Answer": {
            rich_text: []
            },
            "Last Quiz": {
            date: { start: todayStr }
            },
            "Quiz Due": {
            checkbox: false
            }
        }
        })

        wordsToQuiz.sort(() => 0.5 - Math.random());

        if (wordsToQuiz.length === 0) {
            console.log("✅ No words need quizzing today.");
            return;
        }

        console.log(`📝 Processing ${wordsToQuiz.length} words...`);

        // --- 第三步：循环出题 ---
        for (const page of wordsToQuiz) {

            let word = null;
            const nameProp = page.properties["Name"];
            if (nameProp && nameProp.title && nameProp.title.length > 0) {
                word = nameProp.title[0].plain_text;
            }

            if (!word) continue;

            const quizTypes = ["sentence", "definition", "thesaurus"];
            const selectedType = quizTypes[Math.floor(Math.random() * quizTypes.length)];

            console.log(`   - Generating [${selectedType}] for: "${word}"`);

            // Prompt
            let prompt = `Generate a multiple-choice quiz for the word: "${word}". Type: ${selectedType}.
            Strictly output valid JSON only. Format:
            {
              "q": "question",
              "a": "${word}",
              "w": ["wrong1", "wrong2", "wrong3"]
            }`;

            // 构造 URL：注意 modelFullName 已经包含了 "models/" 前缀
            // 例如：https://.../v1beta/models/gemini-1.5-flash:generateContent
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/${modelFullName}:generateContent?key=${geminiApiKey}`;

            const geminiResp = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            });

            if (!geminiResp.ok) {
                const errorText = await geminiResp.text();
                console.error(`   ❌ API ERROR! Status: ${geminiResp.status}`);
                console.error(`   ❌ Detail: ${errorText}`);
                console.log("   ⚠️ Skipping word.");
                continue;
            }

            const gData = await geminiResp.json();

            if (!gData.candidates || gData.candidates.length === 0) {
                console.error("   ❌ 200 OK but NO output.");
                continue;
            }

            let aiText = gData.candidates[0].content.parts[0].text;

            // 提取 JSON
            let quizData = {};
            try {
                const firstBrace = aiText.indexOf('{');
                const lastBrace = aiText.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1) {
                    quizData = JSON.parse(aiText.substring(firstBrace, lastBrace + 1));
                } else {
                    quizData = JSON.parse(aiText);
                }
            } catch (e) {
                console.error("   ⚠️ JSON Parse Failed. Fallback.");
                quizData = { q: `Quiz for ${word}`, a: word, w: ["Option 1", "Option 2", "Option 3"] };
            }

            // 标准化
            const questionText = quizData.q || quizData.question || `Quiz for ${word}`;
            const correctAnswer = quizData.a || quizData.correct || word;
            let distractors = quizData.w || quizData.distractors || [];

            if (!Array.isArray(distractors)) distractors = [];
            while (distractors.length < 3) distractors.push("Option X");
            distractors = distractors.slice(0, 3);

            // 洗牌
            let options = [
                { text: correctAnswer, isCorrect: true },
                { text: distractors[0], isCorrect: false },
                { text: distractors[1], isCorrect: false },
                { text: distractors[2], isCorrect: false }
            ];

            // 1) 洗牌 options
            options.sort(() => Math.random() - 0.5);

            const labels = ["A", "B", "C", "D"];

            // 2) 先拼 finalQuestion / correctLabel（必须在 PATCH 之前）
            let finalQuestion = (questionText || `Choose the correct answer for "${word}".`) + "\n\n";
            let correctLabel = "";

            options.forEach((opt, index) => {
                const label = labels[index];
                finalQuestion += `${label}. ${opt.text}\n`;
                if (opt.isCorrect) correctLabel = label;
            });

            // 3) 再写入 Notion
            const updateResp = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
            method: "PATCH",
            headers: {
                "Authorization": `Bearer ${notionToken}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                properties: {
                "Question": { rich_text: [{ text: { content: finalQuestion } }] },
                "Answer Key": { rich_text: [{ text: { content: correctLabel } }] },
                "My Answer": { rich_text: [] },
                "Last Quiz": { date: { start: todayStr } },
                "Quiz Due": { checkbox: false }
                }
            })
            });

            if (!updateResp.ok) {
                console.error(`   ❌ Notion Update Failed:`, await updateResp.text());
            } else {
                console.log(`   ✅ Generated MCQ for ${word} (Ans: ${correctLabel})`);
            }
        }

        console.log("🎉 All Done!");

    } catch (err) {
        console.error("❌ Fatal Error:", err);
        process.exit(1);
    }
}

main();