// =========================================================================
// AI Tech Interview - Interview Room Client Wrapper
// Client-side wrapper for the InterviewRoom component
// =========================================================================

'use client';

import { InterviewRoom } from '@/components/InterviewRoom';
import type { ResponseEvaluationSummary } from '@/types/interview';

// =========================================================================
// Types
// =========================================================================

interface Question {
  id: string;
  questionNumber: number;
  question: string;
  category: string;
  difficulty: string;
  timeLimit: number;
  topicName?: string;
  responses: Array<{
    id: string;
    transcription?: string;
    durationSeconds?: number;
    status?: string;
    createdAt?: string;
    evaluation?: ResponseEvaluationSummary;
  }>;
}

interface Session {
  id: string;
  roleTitle: string;
  seniorityLevel: string;
}

interface InterviewRoomClientProps {
  session: Session;
  questions: Question[];
}

// =========================================================================
// Component
// =========================================================================

export function InterviewRoomClient({ session, questions }: InterviewRoomClientProps) {
  return <InterviewRoom session={session} questions={questions} />;
}
