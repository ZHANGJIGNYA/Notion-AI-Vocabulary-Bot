// quiz/scripts/runQuiz.js

// 移除 node-fetch，使用 Node 18 原生 fetch
// const fetch = require('node-fetch'); 

async function main() {
    try {
        console.log("🚀 Starting MCQ Quiz Generation (JSON Extractor Mode)...");

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
            let prompt = `Task: Create a Multiple Choice Quiz for the English word: "${word}". Type: ${selectedType}.`;

            if (selectedType === "sentence") {
                prompt += `
                Create a sentence where "${word}" fits perfectly, replacing it with "______".
                Output format:
                {
                    "question": "The sentence...",
                    "correct": "${word}",
                    "distractors": ["word1", "word2", "word3"]
                }`;
            } else if (selectedType === "definition") {
                prompt += `
                Provide an English definition for "${word}".
                Output format:
                {
                    "question": "Definition: ...",
                    "correct": "${word}",
                    "distractors": ["word1", "word2", "word3"]
                }`;
            } else if (selectedType === "thesaurus") {
                prompt += `
                Provide synonyms for "${word}".
                Output format:
                {
                    "question": "Which word means: [synonyms]?",
                    "correct": "${word}",
                    "distractors": ["word1", "word2", "word3"]
                }`;
            }

            prompt += `\nIMPORTANT: Return ONLY the JSON object. Do not add markdown formatting or explanation.`;

            // 调用 Gemini
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
            const geminiResp = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });

            const gData = await geminiResp.json();

            // 获取 AI 原始文本
            let aiText = "{}";
            if (gData && gData.candidates && gData.candidates.length > 0) {
                const firstCandidate = gData.candidates[0];
                if (firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
                    aiText = firstCandidate.content.parts[0].text || "{}";
                }
            }

            // --- 🛠️ 关键修复：JSON 正则提取器 ---
            // 不管 AI 加了多少废话，只提取 { ... } 里面的内容
            let quizData = {};
            try {
                // 1. 找到第一个 '{' 和最后一个 '}'
                const firstBrace = aiText.indexOf('{');
                const lastBrace = aiText.lastIndexOf('}');

                if (firstBrace !== -1 && lastBrace !== -1) {
                    // 截取纯净的 JSON 字符串
                    const jsonString = aiText.substring(firstBrace, lastBrace + 1);
                    quizData = JSON.parse(jsonString);
                } else {
                    throw new Error("No JSON braces found");
                }
            } catch (e) {
                console.error("   ⚠️ JSON Parse Failed. Raw text was:", aiText);
                // 这里我们跳过这个词，不再生成错误的题目
                continue;
            }

            // --- 检查数据完整性 ---
            // 如果 distractors 丢了，还是跳过吧，宁缺毋滥
            if (!quizData.distractors || !Array.isArray(quizData.distractors) || quizData.distractors.length < 3) {
                console.error("   ⚠️ Invalid distractors format. Skipping.");
                continue;
            }

            // --- 🔀 洗牌逻辑 ---
            let options = [
                { text: quizData.correct, isCorrect: true },
                { text: quizData.distractors[0], isCorrect: false },
                { text: quizData.distractors[1], isCorrect: false },
                { text: quizData.distractors[2], isCorrect: false }
            ];

            options.sort(() => Math.random() - 0.5);

            const labels = ["A", "B", "C", "D"];
            let questionText = quizData.question + "\n\n";
            let correctLabel = "";

            options.forEach((opt, index) => {
                const label = labels[index];
                questionText += `${label}. ${opt.text}\n`;
                if (opt.isCorrect) correctLabel = label;
            });

            // 4. 写入 Notion (带错误检查)
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