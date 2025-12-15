// =========================================================================
// AI Tech Interview - Azure OpenAI Client
// =========================================================================

import { AzureOpenAI } from 'openai';
import type {
  AIQuestionGenerationResponse,
  AIEvaluationResponse,
} from '@/types/api';
import type {
  SeniorityLevel,
  InterviewQuestion,
  EvaluationScores,
} from '@/types/interview';
import {
  getQuestionGenerationPrompt,
  getEvaluationPrompt,
} from './prompts';

// =========================================================================
// Environment Validation
// =========================================================================

function getEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// =========================================================================
// Azure OpenAI Client Singleton
// =========================================================================

let openaiClient: AzureOpenAI | null = null;

function getOpenAIClient(): AzureOpenAI {
  if (!openaiClient) {
    openaiClient = new AzureOpenAI({
      apiKey: getEnvVar('AZURE_OPENAI_API_KEY'),
      endpoint: getEnvVar('AZURE_OPENAI_ENDPOINT'),
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    });
  }
  return openaiClient;
}

function getDeploymentName(): string {
  return getEnvVar('AZURE_OPENAI_DEPLOYMENT');
}

// =========================================================================
// Question Generation
// =========================================================================

/**
 * Generate interview questions based on role and job description
 */
export async function generateInterviewQuestions(
  roleTitle: string,
  jobDescription: string,
  seniorityLevel: SeniorityLevel
): Promise<AIQuestionGenerationResponse> {
  const client = getOpenAIClient();
  const deployment = getDeploymentName();

  const systemPrompt = getQuestionGenerationPrompt(seniorityLevel);

  const userPrompt = `
Role Title: ${roleTitle}

Job Description:
${jobDescription}

Generate 10 interview questions following the seniority distribution rules for a ${seniorityLevel}-level candidate.
`;

  const response = await client.chat.completions.create({
    model: deployment,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 4000,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('No response content from Azure OpenAI');
  }

  try {
    const parsed = JSON.parse(content) as AIQuestionGenerationResponse;
    
    // Validate response structure
    if (!parsed.questions || !Array.isArray(parsed.questions)) {
      throw new Error('Invalid response structure: missing questions array');
    }

    return parsed;
  } catch (error) {
    console.error('Failed to parse OpenAI response:', content);
    throw new Error(`Failed to parse question generation response: ${error}`);
  }
}

// =========================================================================
// Response Evaluation
// =========================================================================

/**
 * Evaluate a candidate's response to a question
 */
export async function evaluateResponse(
  question: InterviewQuestion,
  transcription: string,
  roleTitle: string,
  seniorityLevel: SeniorityLevel
): Promise<AIEvaluationResponse> {
  const client = getOpenAIClient();
  const deployment = getDeploymentName();

  const systemPrompt = getEvaluationPrompt();

  const userPrompt = `
CONTEXT:
- Role: ${roleTitle}
- Expected Seniority: ${seniorityLevel}
- Question Category: ${question.category}
- Question Difficulty: ${question.difficulty}

QUESTION:
${question.question}

EXPECTED TOPICS:
${question.expectedTopics.join(', ')}

CANDIDATE RESPONSE (Transcribed from speech):
${transcription}

Evaluate this response according to the scoring criteria.
`;

  const response = await client.chat.completions.create({
    model: deployment,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3, // Lower temperature for more consistent evaluations
    max_tokens: 2000,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('No response content from Azure OpenAI');
  }

  try {
    const parsed = JSON.parse(content) as AIEvaluationResponse;
    
    // Validate response structure
    if (!parsed.scores || typeof parsed.overallScore !== 'number' || !parsed.feedback) {
      throw new Error('Invalid evaluation response structure');
    }

    // Validate score ranges
    validateScores(parsed.scores);

    return parsed;
  } catch (error) {
    console.error('Failed to parse evaluation response:', content);
    throw new Error(`Failed to parse evaluation response: ${error}`);
  }
}

// =========================================================================
// Helpers
// =========================================================================

/**
 * Validate that all scores are within valid range (0-100)
 */
function validateScores(scores: EvaluationScores): void {
  const scoreFields: (keyof EvaluationScores)[] = [
    'relevance',
    'technicalAccuracy',
    'clarity',
    'depth',
    'structure',
    'confidence',
  ];

  for (const field of scoreFields) {
    const score = scores[field];
    if (typeof score !== 'number' || score < 0 || score > 100) {
      throw new Error(`Invalid score for ${field}: ${score}`);
    }
  }
}

/**
 * Extract seniority level from role title
 */
export function extractSeniorityFromRole(roleTitle: string): SeniorityLevel {
  const lowerTitle = roleTitle.toLowerCase();
  
  // Check for senior indicators
  if (
    lowerTitle.includes('senior') ||
    lowerTitle.includes('sr.') ||
    lowerTitle.includes('sr ') ||
    lowerTitle.includes('lead') ||
    lowerTitle.includes('principal') ||
    lowerTitle.includes('staff') ||
    lowerTitle.includes('architect')
  ) {
    return 'senior';
  }
  
  // Check for junior indicators
  if (
    lowerTitle.includes('junior') ||
    lowerTitle.includes('jr.') ||
    lowerTitle.includes('jr ') ||
    lowerTitle.includes('entry') ||
    lowerTitle.includes('associate') ||
    lowerTitle.includes('trainee') ||
    lowerTitle.includes('intern')
  ) {
    return 'junior';
  }
  
  // Default to mid-level
  return 'mid';
}
