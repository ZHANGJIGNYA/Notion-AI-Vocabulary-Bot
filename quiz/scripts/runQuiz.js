// quiz/scripts/runQuiz.js

async function main() {
    try {
        console.log("🚀 Starting MCQ Quiz Generation (Model Fix Mode)...");

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

            // 🚨🚨🚨 核心修改：换模型名字 🚨🚨🚨
            // 尝试使用 'gemini-1.5-flash-latest'。如果报错，请手动改成 'gemini-pro'
            const modelName = "gemini-1.5-flash-latest";
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;

            const geminiResp = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            });

            if (!geminiResp.ok) {
                const errorText = await geminiResp.text();
                console.error(`   ❌ GEMINI API ERROR! Status: ${geminiResp.status}`);
                console.error(`   ❌ Error Details: ${errorText}`);
                console.log("   ⚠️ Skipping this word due to API error.");
                continue;
            }

            const gData = await geminiResp.json();

            if (!gData.candidates || gData.candidates.length === 0) {
                console.error("   ❌ Gemini returned 200 OK, but NO candidates.");
                continue;
            }

            let aiText = gData.candidates[0].content.parts[0].text;
            console.log("   🐛 AI Response Preview:", aiText.substring(0, 50) + "...");

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
                console.error("   ⚠️ JSON Parse Failed. Falling back.");
                quizData = { q: `Quiz for ${word}`, a: word, w: ["Option 1", "Option 2", "Option 3"] };
            }

            // 标准化数据
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