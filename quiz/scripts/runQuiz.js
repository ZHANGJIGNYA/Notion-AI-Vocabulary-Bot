// quiz/scripts/runQuiz.js

async function main() {
    try {
        console.log("🚀 Starting MCQ Quiz Generation (Deep Debug Mode)...");

        const databaseId = process.env.NOTION_DB_ID;
        const notionToken = process.env.NOTION_TOKEN;
        const geminiApiKey = process.env.GEMINI_API_KEY;

        if (!databaseId || !notionToken || !geminiApiKey) {
            throw new Error("❌ Missing Environment Variables!");
        }

        // 1. 筛选 Notion
        const queryResp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${notionToken}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                page_size: 5,
                filter: {
                    and: [
                        { property: "Review Stage", number: { greater_than: 0 } }
                    ]
                }
            })
        });

        const data = await queryResp.json();
        let wordsToQuiz = data.results || [];

        // 日期过滤
        const todayStr = new Date().toISOString().split('T')[0];
        wordsToQuiz = wordsToQuiz.filter(p => {
            const lastQuiz = p.properties["Last Quiz"];
            if (!lastQuiz || !lastQuiz.date) return true;
            return lastQuiz.date.start !== todayStr;
        });

        wordsToQuiz.sort(() => 0.5 - Math.random());

        if (wordsToQuiz.length === 0) {
            console.log("✅ No words need quizzing today.");
            return;
        }

        console.log(`📝 Processing ${wordsToQuiz.length} words...`);

        // 2. 循环出题
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

            // 调用 Gemini (带详细错误检查)
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;

            const geminiResp = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            });

            // 🚨🚨🚨 核心调试点：检查 HTTP 状态码 🚨🚨🚨
            if (!geminiResp.ok) {
                const errorText = await geminiResp.text();
                console.error(`   ❌ GEMINI API ERROR! Status: ${geminiResp.status}`);
                console.error(`   ❌ Error Details: ${errorText}`);
                console.log("   ⚠️ Skipping this word due to API error.");
                continue; // 跳过这个词，防止程序崩溃
            }

            const gData = await geminiResp.json();

            // 🚨🚨🚨 检查返回的数据结构 🚨🚨🚨
            if (!gData.candidates || gData.candidates.length === 0) {
                console.error("   ❌ Gemini returned 200 OK, but NO candidates.");
                console.error("   ❌ Full Response:", JSON.stringify(gData));

                // 如果是被 Safety Filter 拦截了，通常会有 promptFeedback
                if (gData.promptFeedback) {
                    console.error("   ❌ Safety Block:", JSON.stringify(gData.promptFeedback));
                }
                continue;
            }

            // 获取 AI 文本
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
                console.error("   ⚠️ JSON Parse Failed. Raw:", aiText);
                // 这里如果不跳过，就会生成错误题目。为了调试，我们先生成个假题目看看流程对不对
                quizData = { q: "Error generating quiz", a: word, w: ["Error", "Error", "Error"] };
            }

            // 标准化数据
            const questionText = quizData.q || quizData.question || `Quiz for ${word}`;
            const correctAnswer = quizData.a || quizData.correct || word;
            let distractors = quizData.w || quizData.distractors || [];

            if (!Array.isArray(distractors)) distractors = ["Option 1", "Option 2", "Option 3"];
            while (distractors.length < 3) distractors.push("Option X");
            distractors = distractors.slice(0, 3);

            // 洗牌
            let options = [
                { text: correctAnswer, isCorrect: true },
                { text: distractors[0], isCorrect: false },
                { text: distractors[1], isCorrect: false },
                { text: distractors[2], isCorrect: false }
            ];

            options.sort(() => Math.random() - 0.5);

            const labels = ["A", "B", "C", "D"];
            let finalQuestion = questionText + "\n\n";
            let correctLabel = "";

            options.forEach((opt, index) => {
                const label = labels[index];
                finalQuestion += `${label}. ${opt.text}\n`;
                if (opt.isCorrect) correctLabel = label;
            });

            // 写入 Notion
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
                        "My Answer": { rich_text: [] }
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