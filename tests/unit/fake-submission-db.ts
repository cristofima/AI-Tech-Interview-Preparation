// In-memory stand-in for the Prisma transaction client used by
// submitResponse. Only the methods declared in SubmissionTx are implemented.
import type { SubmissionTx, TransactionRunner, ResponseWriteData } from '@/lib/response-submission';

export interface FakeResponseRow extends ResponseWriteData {
  id: string;
  questionId: string;
  sessionId: string;
  createdAt: Date;
}

export interface FakeDb {
  run: TransactionRunner;
  tx: SubmissionTx;
  responses: Map<string, FakeResponseRow>;
  evaluations: Map<string, { responseId: string }>;
  calls: string[];
  seedResponse(partial: Partial<FakeResponseRow> & { questionId: string; sessionId: string }): FakeResponseRow;
  seedEvaluation(responseId: string): string;
}

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}_${++idCounter}`;

export function createFakeDb(seed: { sessions: string[]; questions: Array<{ id: string; sessionId: string }> }): FakeDb {
  const responses = new Map<string, FakeResponseRow>();
  const evaluations = new Map<string, { responseId: string }>();
  const calls: string[] = [];

  const findByNaturalKey = (questionId: string, sessionId: string) =>
    Array.from(responses.values()).find((r) => r.questionId === questionId && r.sessionId === sessionId) ?? null;

  const tx: SubmissionTx = {
    async $executeRaw(query, ...values) {
      calls.push(`raw:${query.join('?')}:${values.join(',')}`);
      return 0;
    },
    interviewSession: {
      async findUnique({ where }) {
        return seed.sessions.includes(where.id) ? { id: where.id } : null;
      },
    },
    interviewQuestion: {
      async findFirst({ where }) {
        const q = seed.questions.find((q) => q.id === where.id && q.sessionId === where.sessionId);
        return q ? { id: q.id } : null;
      },
    },
    questionResponse: {
      async findUnique({ where }) {
        const row = findByNaturalKey(where.questionId_sessionId.questionId, where.questionId_sessionId.sessionId);
        if (!row) return null;
        return {
          id: row.id,
          clientResponseId: row.clientResponseId,
          recordedAt: row.recordedAt,
          completedAt: row.completedAt,
          createdAt: row.createdAt,
          audioSizeBytes: row.audioSizeBytes,
          audioSha256: row.audioSha256,
        };
      },
      async create({ data }) {
        calls.push('create');
        if (findByNaturalKey(data.questionId, data.sessionId)) {
          throw new Error('Unique constraint failed on (questionId, sessionId)');
        }
        if (Array.from(responses.values()).some((r) => r.clientResponseId === data.clientResponseId)) {
          throw new Error('Unique constraint failed on clientResponseId');
        }
        const row: FakeResponseRow = { ...data, id: nextId('resp'), createdAt: new Date() };
        responses.set(row.id, row);
        return { id: row.id, completedAt: row.completedAt };
      },
      async update({ where, data }) {
        calls.push('update');
        const row = responses.get(where.id);
        if (!row) throw new Error('Record not found');
        Object.assign(row, data);
        return { id: row.id, completedAt: row.completedAt };
      },
    },
    responseEvaluation: {
      async deleteMany({ where }) {
        calls.push('deleteEvaluations');
        let count = 0;
        for (const [id, ev] of evaluations) {
          if (ev.responseId === where.responseId) {
            evaluations.delete(id);
            count += 1;
          }
        }
        return { count };
      },
    },
  };

  return {
    run: (fn) => fn(tx),
    tx,
    responses,
    evaluations,
    calls,
    seedResponse(partial) {
      const row: FakeResponseRow = {
        id: nextId('resp'),
        clientResponseId: null as unknown as string,
        recordedAt: null as unknown as Date,
        transcription: null,
        durationSeconds: null,
        audioBlob: null,
        audioMimeType: null,
        audioSizeBytes: null,
        audioSha256: null,
        status: 'completed',
        isOffline: false,
        syncedAt: new Date(0),
        completedAt: new Date('2024-01-01T00:00:00Z'),
        createdAt: new Date('2024-01-01T00:00:00Z'),
        ...partial,
      };
      responses.set(row.id, row);
      return row;
    },
    seedEvaluation(responseId) {
      const id = nextId('eval');
      evaluations.set(id, { responseId });
      return id;
    },
  };
}
