// quiz/scripts/runQuiz.js

async function main() {
    try {
        console.log("🚀 Starting MCQ Quiz Generation (Debug Mode)...");

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

            // --- 🔧 简化版 Prompt (降低 AI 思考难度) ---
            let prompt = `Generate a multiple-choice quiz for the word: "${word}".
            Type: ${selectedType}.
            
            Strictly output valid JSON only. Format:
            {
              "q": "The question text here",
              "a": "${word}",
              "w": ["wrong word 1", "wrong word 2", "wrong word 3"]
            }

            Rules:
            1. "q": The question.
            2. "a": The correct answer (must be the word "${word}").
            3. "w": An array of exactly 3 incorrect options (distractors).
            `;

            if (selectedType === "sentence") prompt += ` For "q", write a sentence with "______" missing.`;
            if (selectedType === "definition") prompt += ` For "q", write the definition.`;
            if (selectedType === "thesaurus") prompt += ` For "q", ask for synonyms.`;

            // 调用 Gemini
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
            const geminiResp = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                        // 暂时去掉 response_mime_type，因为有些旧版 Flash 模型对这个支持不稳定，我们用正则提取更稳
                })
            });

            const gData = await geminiResp.json();

            // 获取 AI 文本
            let aiText = "{}";
            if (gData && gData.candidates && gData.candidates.length > 0) {
                const firstCandidate = gData.candidates[0];
                if (firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
                    aiText = firstCandidate.content.parts[0].text || "{}";
                }
            }

            // 🐛 打印出来给用户看 (关键一步！)
            console.log("   🐛 DEBUG AI OUTPUT:", aiText);

            // --- 🔧 强力 JSON 提取 ---
            let quizData = {};
            try {
                // 尝试提取第一个 { 和最后一个 } 之间的内容
                const firstBrace = aiText.indexOf('{');
                const lastBrace = aiText.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1) {
                    const jsonStr = aiText.substring(firstBrace, lastBrace + 1);
                    quizData = JSON.parse(jsonStr);
                } else {
                    // 如果没找到大括号，尝试直接解析
                    quizData = JSON.parse(aiText);
                }
            } catch (e) {
                console.error("   ❌ JSON Parse Failed. Falling back.");
            }

            // --- 🔧 数据标准化 (兼容 simplified keys) ---
            // 无论 AI 返回 q/question, a/correct, w/distractors，我们都认
            const questionText = quizData.q || quizData.question || `Quiz for ${word}`;
            const correctAnswer = quizData.a || quizData.correct || word;
            let distractors = quizData.w || quizData.distractors || [];

            // 再次检查 distractors 是否为字符串
            if (typeof distractors === 'string') {
                distractors = distractors.split(/,|-|\n/).map(s => s.trim()).filter(s => s.length > 0);
            }
            if (!Array.isArray(distractors)) distractors = [];

            // 如果还是不够，这次我们打印显眼的错误提示，但依然补全以防程序挂掉
            while (distractors.length < 3) {
                distractors.push("⚠️ Error: AI failed option");
            }
            distractors = distractors.slice(0, 3);

            // --- 🔀 洗牌逻辑 ---
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

            // 4. 写入 Notion
            const updateResp = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
                method: "PATCH",
                headers: {
                    "Authorization": `Bearer ${notionToken}`,
                    "Notion-Version": "2022-06-28",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    properties: {
                        "Question": {
                            rich_text: [{ text: { content: finalQuestion } }]
                        },
                        "Answer Key": {
                            rich_text: [{ text: { content: correctLabel } }]
                        },
                        "My Answer": { rich_text: [] }
                    }
                })
            });

            if (!updateResp.ok) {
                const errorDetail = await updateResp.text();
                console.error(`   ❌ Failed to update Notion:`, errorDetail);
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