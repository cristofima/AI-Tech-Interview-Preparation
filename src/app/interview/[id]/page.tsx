// =========================================================================
// AI Tech Interview - Interview Room Page
// Dynamic route for conducting the interview session
// =========================================================================

import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Mic, Clock, ArrowLeft, Volume2 } from 'lucide-react';
import Link from 'next/link';

// =========================================================================
// Types
// =========================================================================

interface InterviewPageProps {
  params: Promise<{ id: string }>;
}

// =========================================================================
// Data Fetching
// =========================================================================

async function getSession(id: string) {
  // For now, fetch from the API route
  // In production, this would be a direct database call
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  
  try {
    const response = await fetch(`${baseUrl}/api/sessions?id=${id}`, {
      cache: 'no-store',
    });
    
    if (!response.ok) {
      return null;
    }
    
    const result = await response.json();
    return result.data;
  } catch (error) {
    console.error('Failed to fetch session:', error);
    return null;
  }
}

// =========================================================================
// Loading Component
// =========================================================================

function InterviewLoading() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
        <p className="text-gray-600">Loading interview session...</p>
      </div>
    </div>
  );
}

// =========================================================================
// Interview Content Component
// =========================================================================

async function InterviewContent({ sessionId }: { sessionId: string }) {
  const sessionData = await getSession(sessionId);
  
  if (!sessionData) {
    notFound();
  }

  const { session, questions = [], topics = [] } = sessionData;

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <Link 
              href="/"
              className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
              <span className="text-sm font-medium">Exit Interview</span>
            </Link>
            
            <div className="text-center">
              <h1 className="text-lg font-semibold text-gray-900 truncate max-w-md">
                {session.roleTitle}
              </h1>
              <p className="text-xs text-gray-500">
                {questions.length} questions • {session.seniorityLevel} level
              </p>
            </div>
            
            <div className="flex items-center gap-2 text-gray-600">
              <Clock className="h-4 w-4" />
              <span className="text-sm font-medium">--:--</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Topics Summary */}
        {topics.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Topics Covered</h2>
            <div className="flex flex-wrap gap-2">
              {topics.map((topic: { name: string; category: string }, index: number) => (
                <span
                  key={index}
                  className={`px-3 py-1 rounded-full text-sm font-medium ${
                    topic.category === 'technical'
                      ? 'bg-blue-100 text-blue-800'
                      : topic.category === 'soft-skills'
                      ? 'bg-green-100 text-green-800'
                      : topic.category === 'system-design'
                      ? 'bg-purple-100 text-purple-800'
                      : 'bg-gray-100 text-gray-800'
                  }`}
                >
                  {topic.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Questions List */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Interview Questions</h2>
            <p className="text-sm text-gray-500 mt-1">
              Click on a question to start recording your response
            </p>
          </div>
          
          <div className="divide-y divide-gray-100">
            {questions.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                <p>Questions are being generated...</p>
                <p className="text-sm mt-2">Please refresh the page in a few moments.</p>
              </div>
            ) : (
              questions.map((question: {
                id: string;
                questionNumber: number;
                question: string;
                category: string;
                difficulty: string;
                timeLimit: number;
                topicName?: string;
              }) => (
                <div
                  key={question.id}
                  className="p-6 hover:bg-gray-50 transition-colors cursor-pointer group"
                >
                  <div className="flex items-start gap-4">
                    <div className="flex-shrink-0">
                      <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-700 text-sm font-semibold">
                        {question.questionNumber}
                      </span>
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-900 font-medium mb-2">
                        {question.question}
                      </p>
                      
                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        <span className={`px-2 py-0.5 rounded ${
                          question.category === 'technical'
                            ? 'bg-blue-50 text-blue-700'
                            : question.category === 'behavioral'
                            ? 'bg-green-50 text-green-700'
                            : question.category === 'system-design'
                            ? 'bg-purple-50 text-purple-700'
                            : 'bg-gray-50 text-gray-700'
                        }`}>
                          {question.category}
                        </span>
                        
                        <span className={`px-2 py-0.5 rounded ${
                          question.difficulty === 'senior'
                            ? 'bg-red-50 text-red-700'
                            : question.difficulty === 'mid'
                            ? 'bg-yellow-50 text-yellow-700'
                            : 'bg-green-50 text-green-700'
                        }`}>
                          {question.difficulty}
                        </span>
                        
                        <span className="text-gray-500 flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {Math.floor(question.timeLimit / 60)} min
                        </span>
                        
                        {question.topicName && (
                          <span className="text-gray-400">
                            • {question.topicName}
                          </span>
                        )}
                      </div>
                    </div>
                    
                    <div className="flex-shrink-0 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        className="p-2 rounded-lg bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors"
                        title="Listen to question"
                      >
                        <Volume2 className="h-4 w-4" />
                      </button>
                      <button
                        className="p-2 rounded-lg bg-red-100 text-red-700 hover:bg-red-200 transition-colors"
                        title="Record response"
                      >
                        <Mic className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-8 flex justify-center gap-4">
          <Link
            href="/"
            className="px-6 py-3 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 transition-colors"
          >
            Save & Exit
          </Link>
          <button
            className="px-6 py-3 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 transition-colors flex items-center gap-2"
          >
            <Mic className="h-5 w-5" />
            Start Interview
          </button>
        </div>
      </main>
    </div>
  );
}

// =========================================================================
// Page Component
// =========================================================================

export default async function InterviewPage({ params }: InterviewPageProps) {
  const { id } = await params;
  
  return (
    <Suspense fallback={<InterviewLoading />}>
      <InterviewContent sessionId={id} />
    </Suspense>
  );
}

// =========================================================================
// Metadata
// =========================================================================

export async function generateMetadata({ params }: InterviewPageProps) {
  const { id } = await params;
  
  return {
    title: `Interview Session - AI Tech Interview Prep`,
    description: `Practice interview session ${id}`,
  };
}
