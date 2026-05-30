/**
 * Multi-Provider AI Integration Layer (Gemini & Groq)
 */

// Base request sender
async function sendAiRequest(apiKey, prompt, provider = 'gemini') {
  // Use correct proxy endpoint depending on chosen provider
  const url = provider === 'groq' ? '/api/groq' : '/api/gemini';

  const payload = {
    prompt,
    clientApiKey: apiKey
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  let isRateLimited = (response.status === 429);
  let errMsg = `Server returned status ${response.status}`;
  try {
    const cloned = response.clone();
    const errPayload = await cloned.json();
    if (errPayload && errPayload.status === 429) {
      isRateLimited = true;
    }
    if (errPayload && errPayload.error) {
      if (typeof errPayload.error === 'string') {
        errMsg = errPayload.error;
      } else if (errPayload.error.message) {
        errMsg = errPayload.error.message;
      }
    }
  } catch (_) {}

  if (isRateLimited) {
    throw new Error('QUOTA_EXCEEDED');
  }

  if (!response.ok) {
    throw new Error(`${provider === 'groq' ? 'Groq' : 'Gemini'} API rejected request: ${errMsg}`);
  }

  const result = await response.json();

  if (provider === 'groq') {
    const generatedText = result?.choices?.[0]?.message?.content;
    if (!generatedText) {
      throw new Error('No content returned from Groq. Please attempt generating again.');
    }
    return generatedText;
  } else {
    const candidate = result?.candidates?.[0];
    const generatedText = candidate?.content?.parts?.[0]?.text;
    
    if (!generatedText) {
      if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
        throw new Error(`AI generation stopped due to policy reasons (${candidate.finishReason}). Please try adjusting prompt parameters.`);
      }
      throw new Error('No content returned from the model. Please attempt generating again.');
    }

    return generatedText;
  }
}

// 1. Generate Lesson Plan
export async function generateLessonPlan({ apiKey, provider, subject, topic, grade, duration }) {
  const prompt = `You are an experienced K-12 teacher holding multiple curriculum design awards. 
Create a comprehensive, structured lesson plan for the subject "${subject}" centered around the topic "${topic}".
- Target Student Audience Grade Level: ${grade || 'General K-12 school age'}
- Targeted Class Session Duration: ${duration || '45 minutes'}

Please design and return an extremely detailed lesson plan outline containing exactly these 5 numbered headers/sub-sections:
1. learning objectives (specific, realistic, observable outcomes)
2. lesson hook (creative, attention-grabbing introduction idea under 5 minutes)
3. core instructional activity (step-by-step description of class tasks, active learning activities, and time-block pacing)
4. instant quick assessment (specific checks for student comprehension during the lesson)
5. homework/next-steps task (relevant enrichment exercise aligned to goals)

Formatting: Present your response cleanly in clear, accessible text with a warm educational structure, using markdown subtitles if needed. Avoid conversational introduction or outro. Start immediately with the plan title.`;

  return await sendAiRequest(apiKey, prompt, provider);
}

// 2. Draft Parent Message
export async function generateParentMessage({ apiKey, provider, studentName, messageType, context }) {
  const prompt = `You are a professional, empathetic, and communicative K-12 educator. 
Compose a polite, constructive email/message to the parent/guardian of their child "${studentName}" regarding:
Topic of Focus: "${messageType}".

Additional Teacher's Notes/Observations Context:
"${context || 'No supplementary detail provided. Focus on standard progress updates.'}"

Instruction Rules:
- Keep the messages highly supportive, respectful, objective, and empathetic. 
- Offer a collaborative, supportive voice from the teacher's side.
- Make sure the composition is under 150 words total.
- Avoid using placeholders like "[Parent Name]" or "[Jane's Name]" — write a generic, professional greeting (e.g., "Dear Parent/Guardian,") or reference the child's name directly where appropriate.

Formatting: Return only the final ready-to-use message draft, avoiding meta-remarks or introductions.`;

  return await sendAiRequest(apiKey, prompt, provider);
}

// 3. Synthesize Progress Assessment Report
export async function generateProgressReport({ apiKey, provider, name, gradeAvg, attendanceRate, incidentCount }) {
  const prompt = `You are a expert K-12 teacher completing end-of-term evaluations. 
Based on the objective student data indexed below, write a high-utility, beautiful 3-paragraph educational assessment report.

Student Information:
- Student's Full Profile Name: ${name}
- Calculated Academic Average across Subjects: ${gradeAvg}%
- Classroom Attendance Percentage Factor: ${attendanceRate}%
- Total Behavior/Safety Incidents Logged in DB: ${incidentCount}

Requirements for the 3 paragraphs:
- Paragraph 1: Academic standing summary. Commend their specific strength indices, contextualizing their grade average of ${gradeAvg}%.
- Paragraph 2: Attendance, presence level, and class work engagement score. Address how their attendance velocity (${attendanceRate}%) affects classroom community immersion and learning tracks.
- Paragraph 3: Behavioral development & progress strategy going forward. If they have logged incident scores (${incidentCount} incidents), provide a constructive, supportive pathway for engagement and focus. If they have 0 incidents, praise their outstanding model behavior, active focus, and leadership.

Tone: Strictly objective, positive, professional, encouraging, and actionable. Keep the total output concise but thoroughly meaningful. Avoid introductory filler, start directly with the report content.`;

  return await sendAiRequest(apiKey, prompt, provider);
}

