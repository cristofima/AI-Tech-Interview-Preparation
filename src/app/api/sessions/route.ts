// =========================================================================
// AI Tech Interview - Sessions API Route
// POST: Create a new interview session (persisted to PostgreSQL)
// GET: Get a session by ID (via query param)
// =========================================================================

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateInterviewQuestions, extractSeniorityFromRole } from '@/lib/azure-openai';
import type { CreateSessionInput } from '@/types/interview';
import type { ApiResponse, CreateSessionResponse } from '@/types/api';

/**
 * POST /api/sessions
 * Create a new interview session and generate questions
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<ApiResponse<CreateSessionResponse>>> {
  try {
    const body = (await request.json()) as CreateSessionInput;

    // Validate input
    if (!body.roleTitle || body.roleTitle.trim().length < 10) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_ROLE_TITLE',
            message: 'Role title must be at least 10 characters',
          },
        },
        { status: 400 }
      );
    }

    if (!body.jobDescription || body.jobDescription.trim().length < 50) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_JOB_DESCRIPTION',
            message: 'Job description must be at least 50 characters',
          },
        },
        { status: 400 }
      );
    }

    // Extract seniority level from role title
    const seniorityLevel = extractSeniorityFromRole(body.roleTitle);

    // Create session in database first (before calling OpenAI)
    const session = await prisma.interviewSession.create({
      data: {
        roleTitle: body.roleTitle.trim(),
        jobDescription: body.jobDescription.trim(),
        seniorityLevel,
        status: 'created',
      },
    });

    console.log(`Session ${session.id} created, generating questions...`);

    try {
      // Generate questions using Azure OpenAI (now with topic extraction)
      const generatedQuestions = await generateInterviewQuestions(
        session.roleTitle,
        session.jobDescription,
        seniorityLevel
      );

      // Store topics in database
      const topicsData = generatedQuestions.topics || [];
      const createdTopics = await Promise.all(
        topicsData.map((topic) =>
          prisma.interviewTopic.create({
            data: {
              sessionId: session.id,
              name: topic.name,
              description: topic.description,
              priority: topic.priority,
            },
          })
        )
      );

      // Create a map of topic names to IDs
      const topicNameToId = new Map<string, string>();
      for (const t of createdTopics) {
        topicNameToId.set(t.name, t.id);
      }

      // Store questions in database
      const questionsData = generatedQuestions.questions.map((q, index) => ({
        sessionId: session.id,
        topicId: q.topicName ? (topicNameToId.get(q.topicName) ?? null) : null,
        questionNumber: index + 1,
        question: q.question,
        category: q.category,
        difficulty: q.difficulty,
        expectedTopics: q.expectedTopics,
        timeLimitSeconds: q.timeLimitSeconds,
      }));

      await prisma.interviewQuestion.createMany({
        data: questionsData,
      });

      // Update session status
      const updatedSession = await prisma.interviewSession.update({
        where: { id: session.id },
        data: { status: 'in-progress' },
      });

      console.log(
        `Session ${session.id}: Generated ${questionsData.length} questions from ${topicsData.length} topics`
      );

      return NextResponse.json(
        {
          success: true,
          data: {
            session: {
              id: updatedSession.id,
              roleTitle: updatedSession.roleTitle,
              jobDescription: updatedSession.jobDescription,
              seniorityLevel: seniorityLevel, // Use the typed variable
              status: 'in-progress' as const, // Use the literal type
              createdAt: updatedSession.createdAt.toISOString(),
              updatedAt: updatedSession.updatedAt.toISOString(),
            },
            topics: topicsData,
            questionCount: questionsData.length,
          },
        },
        { status: 201 }
      );
    } catch (openAiError) {
      // If OpenAI fails, mark session as failed but keep it in DB
      await prisma.interviewSession.update({
        where: { id: session.id },
        data: { status: 'cancelled' },
      });

      console.error('OpenAI error:', openAiError);
      throw openAiError;
    }
  } catch (error) {
    console.error('Error creating session:', error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Failed to create session',
        },
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/sessions?id=xxx
 * Get a session with its questions and topics
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const sessionId = request.nextUrl.searchParams.get('id');

    if (!sessionId) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'MISSING_SESSION_ID',
            message: 'Session ID is required',
          },
        },
        { status: 400 }
      );
    }

    // Fetch session with related data from database
    const session = await prisma.interviewSession.findUnique({
      where: { id: sessionId },
      include: {
        topics: {
          orderBy: { priority: 'asc' },
        },
        questions: {
          orderBy: { questionNumber: 'asc' },
          include: {
            topic: true,
          },
        },
        responses: true,
      },
    });

    if (!session) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: 'Session not found',
          },
        },
        { status: 404 }
      );
    }

    // Transform questions to include topicName and timeLimit alias
    const questionsWithTopicName = session.questions.map((q: typeof session.questions[number]) => ({
      id: q.id,
      sessionId: q.sessionId,
      topicId: q.topicId,
      topicName: q.topic?.name,
      questionNumber: q.questionNumber,
      question: q.question,
      category: q.category,
      difficulty: q.difficulty,
      expectedTopics: q.expectedTopics,
      timeLimitSeconds: q.timeLimitSeconds,
      timeLimit: q.timeLimitSeconds, // Alias for UI
      createdAt: q.createdAt.toISOString(),
    }));

    // Transform topics
    const topicsData = session.topics.map((t: typeof session.topics[number]) => ({
      name: t.name,
      description: t.description,
      priority: t.priority,
      category: 'technical', // Default, can be enhanced later
    }));

    return NextResponse.json({
      success: true,
      data: {
        session: {
          id: session.id,
          roleTitle: session.roleTitle,
          jobDescription: session.jobDescription,
          seniorityLevel: session.seniorityLevel,
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
          completedAt: session.completedAt?.toISOString(),
        },
        questions: questionsWithTopicName,
        topics: topicsData,
        responses: session.responses,
        currentQuestionIndex: 0, // TODO: Calculate based on responses
      },
    });
  } catch (error) {
    console.error('Error getting session:', error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to get session',
        },
      },
      { status: 500 }
    );
  }
}
