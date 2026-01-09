// quiz/scripts/runQuiz.js

async function main() {
    try {
        console.log("🚀 Starting MCQ Quiz Generation (JSON Mode + AutoFix)...");

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

            // 构造 Prompt
            let prompt = `Task: Create a Multiple Choice Quiz for the English word: "${word}". Type: ${selectedType}.
            
            Output JSON Schema:
            {
                "question": "string (The question text)",
                "correct": "string (The correct answer word)",
                "distractors": ["string", "string", "string"] (Array of 3 incorrect words)
            }
            `;

            if (selectedType === "sentence") {
                prompt += `
                Requirement: Create a sentence where "${word}" fits perfectly, replacing it with "______".
                Distractors must be the same part of speech and contextually plausible but wrong.`;
            } else if (selectedType === "definition") {
                prompt += `
                Requirement: Provide a clear English definition for "${word}".`;
            } else if (selectedType === "thesaurus") {
                prompt += `
                Requirement: Ask "Which word means: [synonyms]?".`;
            }

            // 调用 Gemini (开启 JSON Mode)
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
            const geminiResp = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    // 🌟 核心修改：强制开启 JSON 模式
                    generationConfig: {
                        response_mime_type: "application/json"
                    }
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

            let quizData = {};
            try {
                // 直接解析，因为开了 JSON Mode，通常不需要正则清洗了
                quizData = JSON.parse(aiText);
            } catch (e) {
                console.error("   ⚠️ JSON Parse Failed. AI Output:", aiText);
                continue;
            }

            // --- 🛡️ 自动修复逻辑 (Auto Fix) ---

            // 修复 1: 如果 distractors 是字符串 (例如 "a, b, c")，自动转数组
            if (typeof quizData.distractors === 'string') {
                quizData.distractors = quizData.distractors.split(/,|-|\n/).map(s => s.trim()).filter(s => s.length > 0);
            }

            // 修复 2: 如果 distractors 还是空的或者不够，从备用库里补
            if (!Array.isArray(quizData.distractors)) {
                quizData.distractors = [];
            }

            // 补全不够的选项，防止报错跳过
            while (quizData.distractors.length < 3) {
                quizData.distractors.push("Another Option");
            }

            // 截断多余的 (万一给了 10 个)
            quizData.distractors = quizData.distractors.slice(0, 3);


            // --- 🔀 洗牌逻辑 ---
            let options = [
                { text: quizData.correct || word, isCorrect: true }, // 这里的 fallback 防止 correct 为空
                { text: quizData.distractors[0], isCorrect: false },
                { text: quizData.distractors[1], isCorrect: false },
                { text: quizData.distractors[2], isCorrect: false }
            ];

            options.sort(() => Math.random() - 0.5);

            const labels = ["A", "B", "C", "D"];
            let questionText = (quizData.question || `Quiz for ${word}`) + "\n\n";
            let correctLabel = "";

            options.forEach((opt, index) => {
                const label = labels[index];
                questionText += `${label}. ${opt.text}\n`;
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
                            rich_text: [{ text: { content: questionText } }]
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