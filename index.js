require('dotenv').config();
const { App } = require('@slack/bolt');
const { createClient } = require('@supabase/supabase-js');

// ── INIT ─────────────────────────────────────────────────────────────────────

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const MAX_CONCURRENT_SESSIONS = 20;   // ← change this to raise/lower the cap
const STALE_SESSION_MINUTES   = 30;   // sessions older than this count as abandoned

// ── HELPERS ───────────────────────────────────────────────────────────────────

// Retry wrapper — retries up to 2x with exponential backoff
async function withRetry(fn, retries = 2, delay = 300) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
}

// In-memory question cache — avoids a DB round-trip on every answer submission
let questionsCache = null;
let questionsCacheTime = 0;
let questionsCacheRefresh = null; // in-flight promise — prevents cache stampede
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getQuestionsCache() {
  if (questionsCache && Date.now() - questionsCacheTime < CACHE_TTL) {
    return questionsCache;
  }
  // If a refresh is already in flight, share it — don't fire another DB query
  if (questionsCacheRefresh) return questionsCacheRefresh;
  questionsCacheRefresh = (async () => {
    const { data, error } = await supabase.from('questions').select('*, personas(name, title, image_url)');
    if (error) throw new Error(`Failed to load question cache: ${error.message}`);
    questionsCache = new Map(data.map(q => [q.id, normalizeQuestion(q)]));
    questionsCacheTime = Date.now();
    questionsCacheRefresh = null;
    return questionsCache;
  })();
  return questionsCacheRefresh;
}

async function getRandomQuestions(n = 10) {
  const { data, error } = await supabase.rpc('get_random_questions', { n });
  if (error) throw new Error(`Failed to fetch questions: ${error.message}`);
  return data;
}

function mcInputBlock(question) {
  const options = [
    { key: 'A', text: question.option_a },
    { key: 'B', text: question.option_b },
    { key: 'C', text: question.option_c },
    { key: 'D', text: question.option_d },
  ].filter(o => o.text);

  return {
    type: 'input',
    block_id: 'answer_block',
    label: { type: 'plain_text', text: 'Select your answer' },
    element: {
      type: 'radio_buttons',
      action_id: 'selected_option',
      options: options.map(o => ({
        text: { type: 'plain_text', text: `${o.key}: ${o.text}` },
        value: o.key,
      })),
    },
  };
}

function frInputBlock() {
  return {
    type: 'input',
    block_id: 'answer_block',
    label: { type: 'plain_text', text: 'Your answer (numbers only)' },
    element: {
      type: 'plain_text_input',
      action_id: 'text_value',
      placeholder: { type: 'plain_text', text: 'Enter a number...' },
    },
  };
}

// Normalize question data from both RPC (flat) and direct fetch (nested persona)
function normalizeQuestion(q) {
  return {
    ...q,
    persona_name:      q.persona_name      || q.personas?.name      || null,
    persona_title:     q.persona_title     || q.personas?.title     || null,
    persona_image_url: q.persona_image_url || q.personas?.image_url || null,
  };
}

function buildQuestionModal(question, sessionId, questionNumber, question_ids, answers, started_at) {
  const q = normalizeQuestion(question);
  const blocks = [];

  // Progress
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Question ${questionNumber} of 10*` },
  });

  blocks.push({ type: 'divider' });

  // Persona label + image + name
  const imageUrl = q.persona_image_url || q.image_url;
  if (imageUrl || q.persona_name) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '👤 *Your client*' }],
    });
  }

  if (imageUrl) {
    blocks.push({
      type: 'image',
      image_url: imageUrl,
      alt_text: q.persona_name || `Question ${questionNumber}`,
    });
  }

  if (q.persona_name) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${q.persona_name}*` },
    });
  }

  blocks.push({ type: 'divider' });

  // Scenario label + text
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Scenario*\n${q.scenario}` },
  });

  // Answer input
  if (q.type === 'multiple_choice') {
    blocks.push(mcInputBlock(q));
  } else {
    blocks.push(frInputBlock());
  }

  return {
    type: 'modal',
    callback_id: 'quiz_answer',
    notify_on_close: true,
    private_metadata: JSON.stringify({ sessionId, currentQuestionId: q.id, currentIndex: questionNumber - 1, question_ids, answers, started_at }),
    title: { type: 'plain_text', text: 'Pricing Quiz' },
    submit: { type: 'plain_text', text: 'Submit Answer' },
    blocks,
  };
}

function errorModal(message) {
  return {
    type: 'modal',
    callback_id: 'quiz_error',
    title: { type: 'plain_text', text: 'Error' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:warning: ${message}` },
      },
    ],
  };
}

// Format seconds as M:SS (e.g. 90 → "1:30", 30 → "0:30")
function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function calculateScore(correctCount, totalSeconds) {
  const accuracyScore = (correctCount / 10) * 300;
  // Speed bonus: 200 pts at 0s, 0 pts at 5:00 (300s), linear scale
  const speedBonus = Math.max(0, Math.round(200 * (300 - totalSeconds) / 300));
  const finalScore = Math.round(accuracyScore + speedBonus);
  return { accuracyScore, speedBonus, finalScore };
}

function buildResultsModal(correctCount, totalSeconds, score) {
  const { accuracyScore, speedBonus, finalScore } = score;

  return {
    type: 'modal',
    callback_id: 'quiz_results',
    title: { type: 'plain_text', text: 'Quiz Complete!' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🎉 Your Results' },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Correct Answers:*\n${correctCount} / 10` },
          { type: 'mrkdwn', text: `*Time:*\n${formatTime(totalSeconds)}` },
          { type: 'mrkdwn', text: `*Accuracy Score:*\n${accuracyScore} pts` },
          { type: 'mrkdwn', text: `*Speed Bonus:*\n+${speedBonus} pts` },
          { type: 'mrkdwn', text: `*🏆 Final Score:*\n${finalScore} pts` },
        ],
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'Your score has been posted to the leaderboard channel.' },
        ],
      },
    ],
  };
}

function buildFeedbackModal(isCorrect, question, sessionId, nextIndex, isLastQuestion, nextQuestionId, question_ids, answers, started_at) {
  const blocks = [];

  // Result header
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: isCorrect ? ':white_check_mark: *Correct!*' : ':x: *Incorrect*',
    },
  });

  // If wrong, show the correct answer and explanation
  if (!isCorrect) {
    let correctDisplay;
    if (question.type === 'multiple_choice') {
      const optionMap = {
        A: question.option_a,
        B: question.option_b,
        C: question.option_c,
        D: question.option_d,
      };
      const correctText = optionMap[question.correct?.toUpperCase()];
      correctDisplay = `${question.correct?.toUpperCase()} — ${correctText}`;
    } else {
      correctDisplay = question.correct;
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Correct answer:* ${correctDisplay}` },
    });

    if (question.explanation) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Explanation:* ${question.explanation}` },
      });
    }
  }

  return {
    type: 'modal',
    callback_id: 'quiz_feedback',
    notify_on_close: true,
    private_metadata: JSON.stringify({ sessionId, nextIndex, isLastQuestion, nextQuestionId, question_ids, answers, started_at }),
    title: { type: 'plain_text', text: 'Pricing Quiz' },
    submit: { type: 'plain_text', text: isLastQuestion ? 'See Results' : 'Next Question' },
    blocks,
  };
}

async function postScoreToChannel(userId, userName, correctCount, totalSeconds, finalScore) {
  // 1. Always post score to quiz channel
  await app.client.chat.postMessage({
    channel: process.env.QUIZ_CHANNEL_ID,
    text: `${userName} scored ${finalScore} pts on the pricing quiz!`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<@${userId}> just scored *${finalScore} pts* on the pricing quiz! — ${correctCount}/10 correct • ${formatTime(totalSeconds)}`,
        },
      },
    ],
  });

  // 2. Check if score makes top 10 (best score per user only)
  const { data: topScores, error } = await supabase
    .rpc('get_top_scores', { limit_count: 10 });

  if (error) throw new Error(`Failed to fetch leaderboard: ${error.message}`);

  const isInTopTen = topScores.some(s => s.user_id === userId && s.final_score === finalScore);
  if (!isInTopTen) return;

  // Build leaderboard post
  const isNewTopScore = topScores[0]?.user_id === userId && topScores[0]?.final_score === finalScore;
  const blocks = [];

  if (isNewTopScore) {
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: '🏆 NEW TOP SCORE!' },
    });
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `<@${userId}> just made the leaderboard with *${finalScore} pts!* — ${correctCount}/10 correct • ${formatTime(totalSeconds)}`,
    },
  });

  blocks.push({ type: 'divider' });

  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const leaderLines = topScores.map((s, i) =>
    `${medals[i]} *${s.user_name}* — ${s.final_score} pts (${s.correct_count}/10 • ${formatTime(s.total_seconds)})`
  );

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*🏅 Top 10 Leaderboard*\n${leaderLines.join('\n')}`,
    },
  });

  await app.client.chat.postMessage({
    channel: LEADERBOARD_CHANNEL_ID,
    text: `${userName} made the top 10 leaderboard with ${finalScore} pts!`,
    blocks,
  });
}

// ── COMMAND: /pricing-quiz ────────────────────────────────────────────────────

app.command('/pricing-quiz', async ({ command, ack, respond, client }) => {
  await ack();

  const userId = command.user_id;

  try {
    // Step 1: delete this user's orphaned sessions FIRST so they don't count toward the cap
    await withRetry(() =>
      supabase.from('quiz_sessions').delete().eq('user_id', userId).eq('completed', false)
    );

    // Step 2: parallel — check active session count + fetch random questions
    const staleThreshold = new Date(Date.now() - STALE_SESSION_MINUTES * 60 * 1000).toISOString();
    const [countResult, questions] = await Promise.all([
      supabase
        .from('quiz_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('completed', false)
        .gte('started_at', staleThreshold),
      getRandomQuestions(10),
    ]);

    const activeCount = countResult.count ?? 0;
    if (activeCount >= MAX_CONCURRENT_SESSIONS) {
      await respond({
        response_type: 'ephemeral',
        text: `⏳ The quiz is at capacity right now — ${MAX_CONCURRENT_SESSIONS} people are already taking it. Leo didn't want to spend money on infra. Try again in a few minutes!`,
      });
      return;
    }

    if (!questions || questions.length < 10) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: userId,
        text: ':warning: Not enough questions in the database. Please ask an admin to add more.',
      });
      return;
    }

    const questionIds = questions.map(q => q.id);
    const started_at = new Date().toISOString();

    // Create quiz session
    const { data: session, error: sessionError } = await withRetry(() =>
      supabase.from('quiz_sessions').insert({
        user_id: userId,
        question_ids: questionIds,
        current_index: 0,
        answers: [],
        started_at,
        completed: false,
      }).select().single()
    );

    if (sessionError) throw sessionError;

    // Open modal — pass question_ids, answers, started_at so quiz never needs to read DB again
    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildQuestionModal(questions[0], session.id, 1, questionIds, [], started_at),
    });

  } catch (err) {
    console.error('Error starting quiz:', err);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: userId,
      text: ':warning: Something went wrong starting the quiz. Please try again.',
    });
  }
});

// ── COMMAND: /quiz-status ─────────────────────────────────────────────────────

app.command('/quiz-status', async ({ command, ack, respond }) => {
  await ack();

  try {
    const staleThreshold = new Date(Date.now() - STALE_SESSION_MINUTES * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from('quiz_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('completed', false)
      .gte('started_at', staleThreshold);

    if (error) throw error;

    const active = count ?? 0;
    const remaining = Math.max(0, MAX_CONCURRENT_SESSIONS - active);
    const bar = '█'.repeat(active) + '░'.repeat(Math.max(0, MAX_CONCURRENT_SESSIONS - active));

    await respond({
      response_type: 'ephemeral',
      text: `Quiz status: ${active}/${MAX_CONCURRENT_SESSIONS} active`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*📊 Quiz Status*\n\`${bar}\`\n*${active} / ${MAX_CONCURRENT_SESSIONS}* active sessions — *${remaining} spot${remaining === 1 ? '' : 's'} open*`,
          },
        },
      ],
    });
  } catch (err) {
    console.error('Error fetching quiz status:', err);
    await respond({ response_type: 'ephemeral', text: ':warning: Could not fetch quiz status.' });
  }
});

// ── VIEW: quiz_answer ─────────────────────────────────────────────────────────

app.view('quiz_answer', async ({ ack, view, body, client }) => {
  const userId = body.user.id;
  const { sessionId, currentQuestionId, currentIndex, question_ids, answers, started_at } = JSON.parse(view.private_metadata);

  // Extract submitted answer
  const answerBlock = view.state.values['answer_block'];
  let submittedAnswer;
  if (answerBlock['selected_option']) {
    submittedAnswer = answerBlock['selected_option'].selected_option?.value;
  } else if (answerBlock['text_value']) {
    submittedAnswer = answerBlock['text_value'].value?.trim();
  }

  try {
    // Question from cache — instant memory lookup, zero DB calls
    const questionsMap = await getQuestionsCache();
    const currentQuestion = questionsMap.get(currentQuestionId);

    if (!currentQuestion) {
      return await ack({ response_action: 'update', view: errorModal('Question not found. Please restart with /pricing-quiz.') });
    }

    // Grade answer
    let isCorrect = false;
    if (currentQuestion.type === 'multiple_choice') {
      isCorrect = submittedAnswer?.toUpperCase() === currentQuestion.correct?.toUpperCase();
    } else {
      const submitted = parseFloat(submittedAnswer);
      const correct = parseFloat(currentQuestion.correct);
      isCorrect = !isNaN(submitted) && !isNaN(correct) && submitted === correct;
    }

    // Build updated answers from metadata — no DB read needed
    const updatedAnswers = [
      ...answers,
      {
        questionId: currentQuestionId,
        submitted: submittedAnswer,
        correct: currentQuestion.correct,
        isCorrect,
      },
    ];

    const nextIndex = currentIndex + 1;
    const isLastQuestion = nextIndex >= 10;
    const nextQuestionId = !isLastQuestion ? question_ids[nextIndex] : null;

    // Fire-and-forget session update — never blocks ack()
    withRetry(() =>
      supabase.from('quiz_sessions')
        .update({ current_index: nextIndex, answers: updatedAnswers })
        .eq('id', sessionId)
    ).catch(err => console.error('Session update failed:', err));

    // ack() with zero DB calls made — purely in-memory
    return await ack({
      response_action: 'update',
      view: buildFeedbackModal(isCorrect, currentQuestion, sessionId, nextIndex, isLastQuestion, nextQuestionId, question_ids, updatedAnswers, started_at),
    });

  } catch (err) {
    console.error('Error processing answer:', err);
    await ack({ response_action: 'update', view: errorModal('An unexpected error occurred. Please restart with /pricing-quiz.') });
  }
});

// ── VIEW: quiz_feedback ───────────────────────────────────────────────────────

app.view('quiz_feedback', async ({ ack, view, body, client }) => {
  const userId = body.user.id;
  const { sessionId, nextIndex, isLastQuestion, nextQuestionId, question_ids, answers, started_at } = JSON.parse(view.private_metadata);

  try {
    if (!isLastQuestion) {
      // Question from cache + state from metadata — zero DB calls before ack()
      const questionsMap = await getQuestionsCache();
      const nextQuestion = questionsMap.get(nextQuestionId);

      if (!nextQuestion) {
        return await ack({ response_action: 'update', view: errorModal('Could not load next question. Please restart.') });
      }

      return await ack({
        response_action: 'update',
        view: buildQuestionModal(nextQuestion, sessionId, nextIndex + 1, question_ids, answers, started_at),
      });

    } else {
      // Quiz complete — calculate score from metadata, zero DB/API before ack()
      const startedAt = started_at.endsWith('Z') ? started_at : started_at + 'Z';
      const totalSeconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
      const correctCount = answers.filter(a => a.isCorrect).length;
      const score = calculateScore(correctCount, totalSeconds);

      // ack() IMMEDIATELY — results shown with zero blocking operations
      await ack({
        response_action: 'update',
        view: buildResultsModal(correctCount, totalSeconds, score),
      });

      // Fire-and-forget everything else after ack
      (async () => {
        try {
          const userInfo = await client.users.info({ user: userId }).catch(() => null);
          const userName = userInfo?.user?.real_name || userInfo?.user?.name || body.user.name;
          await Promise.all([
            withRetry(() =>
              supabase.from('quiz_sessions').update({ completed: true }).eq('id', sessionId)
            ),
            withRetry(() =>
              supabase.from('scores').insert({
                user_id: userId,
                user_name: userName,
                correct_count: correctCount,
                total_seconds: totalSeconds,
                final_score: score.finalScore,
                completed_at: new Date().toISOString(),
              })
            ),
          ]);
          postScoreToChannel(userId, userName, correctCount, totalSeconds, score.finalScore)
            .catch(err => console.error('Error posting to leaderboard:', err));
        } catch (err) {
          console.error('Error finalizing quiz:', err);
        }
      })();
    }

  } catch (err) {
    console.error('Error in quiz_feedback:', err);
    await ack({ response_action: 'update', view: errorModal('An unexpected error occurred. Please restart with /pricing-quiz.') });
  }
});

// ── VIEW CLOSE: free up slot immediately when user exits early ────────────────

async function cleanupSession(view) {
  try {
    const { sessionId } = JSON.parse(view.private_metadata || '{}');
    if (sessionId) {
      await supabase.from('quiz_sessions').delete().eq('id', sessionId).eq('completed', false);
    }
  } catch (err) {
    console.error('Error cleaning up session on close:', err);
  }
}

app.view({ callback_id: 'quiz_answer', type: 'view_closed' }, async ({ ack, view }) => {
  await ack();
  await cleanupSession(view);
});

app.view({ callback_id: 'quiz_feedback', type: 'view_closed' }, async ({ ack, view }) => {
  await ack();
  await cleanupSession(view);
});

// ── START ─────────────────────────────────────────────────────────────────────

(async () => {
  await app.start();
  await getQuestionsCache(); // pre-warm so first user never waits
  console.log('⚡ Pricing Quiz bot is running!');
})();

// ── HEALTH CHECK SERVER (required for Render port binding) ────────────────────

const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});
server.listen(process.env.PORT || 3000, () => {
  console.log(`Health check server listening on port ${process.env.PORT || 3000}`);
});
