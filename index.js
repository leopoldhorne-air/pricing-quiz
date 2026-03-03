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

// ── HELPERS ───────────────────────────────────────────────────────────────────

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

function buildQuestionModal(question, sessionId, questionNumber) {
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
    private_metadata: JSON.stringify({ sessionId }),
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
  const accuracyScore = (correctCount / 10) * 100;
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

function buildFeedbackModal(isCorrect, question, sessionId, nextIndex, isLastQuestion) {
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
    private_metadata: JSON.stringify({ sessionId, nextIndex, isLastQuestion }),
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

app.command('/pricing-quiz', async ({ command, ack, client }) => {
  await ack();

  const userId = command.user_id;

  try {
    // Clean up any incomplete session for this user
    await supabase
      .from('quiz_sessions')
      .delete()
      .eq('user_id', userId)
      .eq('completed', false);

    // Fetch 10 random questions
    const questions = await getRandomQuestions(10);

    if (!questions || questions.length < 10) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: userId,
        text: ':warning: Not enough questions in the database. Please ask an admin to add more.',
      });
      return;
    }

    const questionIds = questions.map(q => q.id);

    // Create quiz session
    const { data: session, error: sessionError } = await supabase
      .from('quiz_sessions')
      .insert({
        user_id: userId,
        question_ids: questionIds,
        current_index: 0,
        answers: [],
        started_at: new Date().toISOString(),
        completed: false,
      })
      .select()
      .single();

    if (sessionError) throw sessionError;

    // Open modal with first question
    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildQuestionModal(questions[0], session.id, 1),
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

// ── VIEW: quiz_answer ─────────────────────────────────────────────────────────

app.view('quiz_answer', async ({ ack, view, body, client }) => {
  const userId = body.user.id;
  const { sessionId } = JSON.parse(view.private_metadata);

  // Extract submitted answer
  const answerBlock = view.state.values['answer_block'];
  let submittedAnswer;
  if (answerBlock['selected_option']) {
    submittedAnswer = answerBlock['selected_option'].selected_option?.value;
  } else if (answerBlock['text_value']) {
    submittedAnswer = answerBlock['text_value'].value?.trim();
  }

  try {
    // Load session
    const { data: session, error: sessionError } = await supabase
      .from('quiz_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      return await ack({ response_action: 'update', view: errorModal('Session not found. Please restart with /pricing-quiz.') });
    }

    const currentIndex = session.current_index;

    // Load current question (with persona)
    const { data: currentQuestion, error: qError } = await supabase
      .from('questions')
      .select('*, personas(name, title, image_url)')
      .eq('id', session.question_ids[currentIndex])
      .single();

    if (qError || !currentQuestion) {
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

    // Append answer to session
    const updatedAnswers = [
      ...session.answers,
      {
        questionId: session.question_ids[currentIndex],
        submitted: submittedAnswer,
        correct: currentQuestion.correct,
        isCorrect,
      },
    ];

    const nextIndex = currentIndex + 1;
    const isLastQuestion = nextIndex >= 10;

    // Update session with answer and advance index
    await supabase
      .from('quiz_sessions')
      .update({ current_index: nextIndex, answers: updatedAnswers })
      .eq('id', sessionId);

    // Show feedback (correct/incorrect + explanation if wrong)
    return await ack({
      response_action: 'update',
      view: buildFeedbackModal(isCorrect, currentQuestion, sessionId, nextIndex, isLastQuestion),
    });

  } catch (err) {
    console.error('Error processing answer:', err);
    await ack({ response_action: 'update', view: errorModal('An unexpected error occurred. Please restart with /pricing-quiz.') });
  }
});

// ── VIEW: quiz_feedback ───────────────────────────────────────────────────────

app.view('quiz_feedback', async ({ ack, view, body, client }) => {
  const userId = body.user.id;
  const { sessionId, nextIndex, isLastQuestion } = JSON.parse(view.private_metadata);

  try {
    if (!isLastQuestion) {
      // Load session to get question IDs
      const { data: session, error: sessionError } = await supabase
        .from('quiz_sessions')
        .select('question_ids')
        .eq('id', sessionId)
        .single();

      if (sessionError || !session) {
        return await ack({ response_action: 'update', view: errorModal('Session not found. Please restart with /pricing-quiz.') });
      }

      const { data: nextQuestion, error: nextQError } = await supabase
        .from('questions')
        .select('*, personas(name, title, image_url)')
        .eq('id', session.question_ids[nextIndex])
        .single();

      if (nextQError || !nextQuestion) {
        return await ack({ response_action: 'update', view: errorModal('Could not load next question. Please restart.') });
      }

      return await ack({
        response_action: 'update',
        view: buildQuestionModal(nextQuestion, sessionId, nextIndex + 1),
      });

    } else {
      // Quiz complete — load session and calculate score
      const { data: session, error: sessionError } = await supabase
        .from('quiz_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

      if (sessionError || !session) {
        return await ack({ response_action: 'update', view: errorModal('Session not found.') });
      }

      const startedAt = session.started_at.endsWith('Z')
        ? session.started_at
        : session.started_at + 'Z';
      const totalSeconds = Math.floor(
        (Date.now() - new Date(startedAt).getTime()) / 1000
      );
      const correctCount = session.answers.filter(a => a.isCorrect).length;
      const score = calculateScore(correctCount, totalSeconds);

      // Get user's real display name
      let userName = body.user.name;
      try {
        const userInfo = await client.users.info({ user: userId });
        userName = userInfo.user.real_name || userInfo.user.name;
      } catch (e) {
        console.warn('Could not fetch user display name, using handle instead.');
      }

      // Mark session complete and save score
      await supabase
        .from('quiz_sessions')
        .update({ completed: true })
        .eq('id', sessionId);

      await supabase.from('scores').insert({
        user_id: userId,
        user_name: userName,
        correct_count: correctCount,
        total_seconds: totalSeconds,
        final_score: score.finalScore,
        completed_at: new Date().toISOString(),
      });

      // Show results modal
      await ack({
        response_action: 'update',
        view: buildResultsModal(correctCount, totalSeconds, score),
      });

      // Post to channel (fire and forget — after ack)
      postScoreToChannel(userId, userName, correctCount, totalSeconds, score.finalScore)
        .catch(err => console.error('Error posting to leaderboard:', err));
    }

  } catch (err) {
    console.error('Error in quiz_feedback:', err);
    await ack({ response_action: 'update', view: errorModal('An unexpected error occurred. Please restart with /pricing-quiz.') });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────

(async () => {
  await app.start();
  console.log('⚡ Pricing Quiz bot is running!');
})();
