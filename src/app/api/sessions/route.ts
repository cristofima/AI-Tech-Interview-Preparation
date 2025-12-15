// =========================================================================
// AI Tech Interview - Sessions API Route
// POST: Create a new interview session
// GET: Get a session by ID (via query param)
// =========================================================================

import { NextRequest, NextResponse } from 'next/server';
import { generateInterviewQuestions, extractSeniorityFromRole } from '@/lib/azure-openai';
import { generateId } from '@/lib/utils';
import type {
  InterviewSession,
  InterviewQuestion,
  CreateSessionInput,
} from '@/types/interview';
import type { ApiResponse, CreateSessionResponse } from '@/types/api';

// In-memory storage for MVP (replace with database in production)
const sessions = new Map<string, InterviewSession>();
const questions = new Map<string, InterviewQuestion[]>();

/**
 * POST /api/sessions
 * Create a new interview session and generate questions
 */
export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<CreateSessionResponse>>> {
  try {
    const body = await request.json() as CreateSessionInput;

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

    // Create session
    const sessionId = generateId();
    const now = new Date().toISOString();

    const session: InterviewSession = {
      id: sessionId,
      roleTitle: body.roleTitle.trim(),
      jobDescription: body.jobDescription.trim(),
      seniorityLevel,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };

    // Generate questions using Azure OpenAI
    const generatedQuestions = await generateInterviewQuestions(
      session.roleTitle,
      session.jobDescription,
      session.seniorityLevel
    );

    // Transform generated questions to full InterviewQuestion objects
    const sessionQuestions: InterviewQuestion[] = generatedQuestions.questions.map(
      (q, index) => ({
        id: generateId(),
        sessionId,
        questionNumber: index + 1,
        question: q.question,
        category: q.category,
        difficulty: q.difficulty,
        expectedTopics: q.expectedTopics,
        timeLimitSeconds: q.timeLimitSeconds,
        createdAt: now,
      })
    );

    // Store in memory (MVP)
    sessions.set(sessionId, session);
    questions.set(sessionId, sessionQuestions);

    // Update session status
    session.status = 'in-progress';
    session.updatedAt = new Date().toISOString();

    return NextResponse.json(
      {
        success: true,
        data: { session },
      },
      { status: 201 }
    );
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
 * Get a session with its questions
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

    const session = sessions.get(sessionId);
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

    const sessionQuestions = questions.get(sessionId) || [];

    return NextResponse.json({
      success: true,
      data: {
        session,
        questions: sessionQuestions,
        currentQuestionIndex: 0, // TODO: Track progress
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

// Export for use in other routes
export { sessions, questions };
