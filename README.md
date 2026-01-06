# 🎙️ AI Tech Interview - Voice-Powered Interview Preparation Platform

<div align="center">

![Next.js](https://img.shields.io/badge/Next.js-16.x-black?style=for-the-badge&logo=next.js)
![Azure OpenAI](https://img.shields.io/badge/Azure%20OpenAI-GPT--4o--mini-0078D4?style=for-the-badge&logo=microsoft-azure)
![Azure Speech](https://img.shields.io/badge/Azure%20Speech-TTS%20%2B%20STT-0078D4?style=for-the-badge&logo=microsoft-azure)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

**An AI-powered technical interview preparation platform that generates role-specific questions, conducts voice-based interviews, and provides detailed feedback with scoring.**

[Getting Started](#-getting-started) • [Features](#-key-features) • [Architecture](#️-architecture) • [Azure Setup](#-azure-services-setup) • [Contributing](#-contributing)

</div>

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [How It Works](#-how-it-works)
- [Technology Stack](#️-technology-stack)
- [Architecture](#️-architecture)
- [Getting Started](#-getting-started)
- [Azure Services Setup](#-azure-services-setup)
- [Project Structure](#-project-structure)
- [Seniority-Based Question Generation](#-seniority-based-question-generation)
- [Evaluation Metrics](#-evaluation-metrics)
- [API Reference](#-api-reference)
- [Cost Estimation](#-cost-estimation)
- [Roadmap](#️-roadmap)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🎯 Overview

**AI Tech Interview** is a fullstack application designed to help software developers prepare for technical interviews through realistic, voice-based practice sessions. The platform leverages Azure AI services to:

1. **Generate tailored interview questions** based on your target role and job description
2. **Read questions aloud** using natural-sounding neural voices
3. **Record and transcribe your responses** in real-time
4. **Evaluate answers** and provide detailed feedback with actionable improvements

### Why This Matters

Traditional interview preparation often lacks the pressure and spontaneity of real interviews. This platform bridges that gap by:

- 🎤 **Voice-first interaction** - Practice speaking your answers, not just writing them
- 🎯 **Role-specific questions** - Questions tailored to your exact target position and seniority level
- 📊 **Objective feedback** - AI-powered evaluation with consistent scoring criteria
- ⚡ **Instant results** - No waiting for feedback; get insights immediately after each session

---

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎯 **Seniority-Aligned Questions** | Questions are generated matching your target seniority level (Junior, Semi-Senior, Senior) |
| 🎤 **Voice Interaction** | Text-to-Speech reads questions; Speech-to-Text captures your responses |
| ⏱️ **Timed Responses** | Each question has a time limit (1-10 min) based on category with visible countdown |
| 🤖 **AI-Powered Evaluation** | GPT-4o-mini analyzes responses against expected competencies |
| 📊 **Detailed Scoring** | Multi-dimensional scoring across 6 evaluation criteria |
| 💼 **Role Customization** | Supports any technical role with custom job descriptions |
| 📝 **Structured Feedback** | Strengths, improvements, and actionable suggestions |
| 🔄 **Session History** | Track progress across multiple practice sessions |

---

## 🔄 How It Works

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           USER INTERVIEW FLOW                                │
└──────────────────────────────────────────────────────────────────────────────┘

     ┌─────────────────┐
     │  1. INPUT       │   User provides:
     │  (MANDATORY)    │   • Role Title (e.g., "Senior FullStack .NET/Angular")
     │                 │   • Job Description (responsibilities, requirements)
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │  2. GENERATION  │   Azure OpenAI generates 10 questions:
     │                 │   • Aligned with specified seniority level
     │                 │   • Covering technical, behavioral, and system design
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │  3. INTERVIEW   │   For each question:
     │     SESSION     │   • Azure TTS reads the question aloud
     │                 │   • User presses "Start Recording" button
     │                 │   • Countdown timer appears (1-10 min based on question type)
     │                 │   • User speaks their response
     │                 │   • Recording stops on timeout or manual stop
     │                 │   • Azure STT transcribes the response
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │  4. EVALUATION  │   Azure OpenAI evaluates each response:
     │                 │   • Scores across 6 dimensions
     │                 │   • Generates detailed feedback
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │  5. RESULTS     │   User receives:
     │   DASHBOARD     │   • Overall score and performance band
     │                 │   • Per-question breakdown
     │                 │   • Improvement recommendations
     └─────────────────┘
```

### ⏱️ Response Timer Flow (MVP)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        RECORDING FLOW PER QUESTION                          │
└─────────────────────────────────────────────────────────────────────────────┘

  1. Question Displayed    2. User Clicks          3. Timer Starts
     + Audio Plays            "🎙️ Start Recording"     (Visible Countdown)
         │                         │                         │
         ▼                         ▼                         ▼
    ┌─────────┐              ┌─────────┐              ┌─────────────┐
    │  🔊 TTS │──────────────│  🎙️ REC │──────────────│  ⏱️ 10:00  │
    │  plays  │              │  START  │              │  (max time) │
    └─────────┘              └─────────┘              └─────────────┘
                                                            │
                    ┌───────────────────────────────────────┤
                    │                                       │
                    ▼                                       ▼
            ┌─────────────┐                         ┌─────────────┐
            │  User says  │                         │  ⏱️ 00:00  │
            │  "Stop" or  │                         │  Timeout!   │
            │  clicks ⏹️   │                         │  Auto-stop  │
            └──────┬──────┘                         └──────┬──────┘
                   │                                       │
                   └───────────────┬───────────────────────┘
                                   │
                                   ▼
                           ┌─────────────┐
                           │  Response   │
                           │  Saved +    │
                           │  Transcribed│
                           └─────────────┘
```

**Key Points:**
- ✅ User **must press a button** to start recording (gives time to think)
- ✅ **Visible countdown timer** shows remaining time (1-10 min based on category)
- ✅ Recording **auto-stops** when time runs out
- ✅ User can **manually stop** earlier if finished
- ✅ Whatever was spoken is **saved and transcribed**

---

## 🛠️ Technology Stack

| Layer | Technology | Version | Purpose |
|-------|------------|---------|---------|
| **Frontend** | Next.js (App Router) | 16.x | React framework with Server Components |
| **Runtime** | React | 19.x | UI library with concurrent features |
| **Language** | TypeScript | 5.x | Type-safe development |
| **Styling** | Tailwind CSS | 4.x | Utility-first CSS with `@theme inline` |
| **AI/LLM** | Azure OpenAI | GPT-4o-mini | Question generation & evaluation |
| **Text-to-Speech** | Azure Speech Service | Neural voices | Reading questions aloud |
| **Speech-to-Text** | Azure Speech Service | Real-time STT | Transcribing user responses |
| **Database** | SQLite / Supabase | - | Session and response storage |
| **Charts** | Recharts | 2.x | Results visualization |

### Why Next.js 16?

- **Turbopack by default** - No need for `--turbopack` flag
- **Server Actions** - Seamless server-side operations without explicit API routes
- **React 19** - Latest concurrent features and improved performance
- **App Router** - Modern file-based routing with layouts and nested routes
- **Streaming** - Real-time response streaming support
- **TypeScript First** - Excellent type safety and developer experience

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (Next.js 16)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Session   │  │  Interview  │  │   Audio     │  │   Results   │        │
│  │   Creator   │  │    Room     │  │  Recorder   │  │  Dashboard  │        │
│  │             │  │             │  │             │  │             │        │
│  │ • Role      │  │ • Question  │  │ • Record    │  │ • Scores    │        │
│  │ • Job Desc  │  │   Display   │  │ • Playback  │  │ • Feedback  │        │
│  │ • Seniority │  │ • Timer     │  │ • Waveform  │  │ • Charts    │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    API LAYER (Next.js API Routes / Server Actions)          │
├─────────────────────────────────────────────────────────────────────────────┤
│  POST /api/sessions    │  POST /api/questions  │  POST /api/evaluate       │
│  GET  /api/sessions    │  GET  /api/speech/token                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                      ┌───────────────┼───────────────┐
                      ▼               ▼               ▼
          ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
          │  Azure OpenAI │  │ Azure Speech  │  │   Database    │
          │  (GPT-4o-mini)│  │   Service     │  │   (SQLite)    │
          │               │  │               │  │               │
          │ • Generate Qs │  │ • TTS (400+   │  │ • Sessions    │
          │ • Evaluate    │  │   voices)     │  │ • Responses   │
          │ • JSON Mode   │  │ • STT (real-  │  │ • Scores      │
          │               │  │   time)       │  │               │
          └───────────────┘  └───────────────┘  └───────────────┘
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 20.x or higher
- **pnpm**, **npm**, **yarn**, or **bun**
- **Azure subscription** with:
  - Azure OpenAI Service access
  - Azure Speech Service resource
- **Modern browser** with microphone access (Chrome, Firefox, Edge recommended)

### Installation

1. **Clone the repository**

```bash
git clone https://github.com/cristofima/AI-Tech-Interview.git
cd AI-Tech-Interview
```

2. **Install dependencies**

```bash
pnpm install
# or
npm install
# or
yarn install
# or
bun install
```

3. **Configure environment variables**

Copy the example file and update with your Azure credentials:

```bash
cp .env.local.example .env.local
```

Then edit `.env.local` with your values:

```bash
# Azure OpenAI Configuration
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
AZURE_OPENAI_API_VERSION=2024-10-21

# Azure Speech Service Configuration
AZURE_SPEECH_KEY=your-speech-key
AZURE_SPEECH_REGION=eastus
```

> 💡 **Terraform Users:** Run `terraform output -raw env_file_content > .env.local` in the `infra/` folder to auto-generate this file after provisioning.

4. **Run the development server**

```bash
pnpm dev
# or
npm run dev
# or
yarn dev
# or
bun dev
```

> **Note:** Next.js 16 uses Turbopack by default - no `--turbopack` flag needed!

5. **Open your browser**

Navigate to [http://localhost:3000](http://localhost:3000)

### Current Dependencies

```json
{
  "dependencies": {
    "next": "16.0.10",
    "react": "19.2.1",
    "react-dom": "19.2.1"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.0.10",
    "tailwindcss": "^4",
    "typescript": "^5"
  }
}
```

### Dependencies to Add for MVP

```bash
# Azure SDKs
pnpm add openai microsoft-cognitiveservices-speech-sdk

# Database
pnpm add better-sqlite3
pnpm add -D @types/better-sqlite3

# UI Components (shadcn/ui)
pnpm add @radix-ui/react-slot class-variance-authority clsx lucide-react

# Charts
pnpm add recharts
```

---

## 🔷 Azure Services Setup

### 1. Azure OpenAI Service

#### Create the Resource

1. Go to [Azure Portal](https://portal.azure.com)
2. Search for "Azure OpenAI" and click **Create**
3. Select your subscription and resource group
4. Choose a region (e.g., East US)
5. Provide a unique name for your resource
6. Select pricing tier (Standard S0)
7. Review and create

#### Deploy a Model

1. Navigate to your Azure OpenAI resource
2. Go to **Model deployments** → **Manage Deployments**
3. Click **Create new deployment**
4. Select model: `gpt-4o-mini`
5. Provide a deployment name (e.g., `gpt-4o-mini`)
6. Set tokens-per-minute rate limit as needed

#### Get Credentials

1. Go to **Keys and Endpoint** in your resource
2. Copy **KEY 1** or **KEY 2** → `AZURE_OPENAI_API_KEY`
3. Copy **Endpoint** → `AZURE_OPENAI_ENDPOINT`

### 2. Azure Speech Service

#### Create the Resource

1. Go to [Azure Portal](https://portal.azure.com)
2. Search for "Speech" and select **Speech Services**
3. Click **Create**
4. Select your subscription and resource group
5. Choose a region (e.g., East US)
6. Provide a unique name
7. Select pricing tier (Free F0 for development, Standard S0 for production)
8. Review and create

#### Get Credentials

1. Go to **Keys and Endpoint** in your Speech resource
2. Copy **KEY 1** → `AZURE_SPEECH_KEY`
3. Note the **Location/Region** → `AZURE_SPEECH_REGION`

### Supported Azure OpenAI Models

| Model | Version | Features |
|-------|---------|----------|
| `gpt-4o-mini` | 2024-07-18 | ✅ JSON Mode, ✅ Structured Outputs, Fast, Cost-effective |
| `gpt-4o` | 2024-08-06+ | ✅ JSON Mode, ✅ Structured Outputs, Higher capability |
| `gpt-4.1-mini` | 2025-04-14 | ✅ JSON Mode, ✅ Structured Outputs, Latest features |

---

## 📁 Project Structure

```
AI-Tech-Interview/
├── infra/                              # Terraform Infrastructure-as-Code
│   ├── main.tf                         # Azure resources (OpenAI, Speech)
│   ├── variables.tf                    # Input variables
│   ├── outputs.tf                      # Output values
│   ├── versions.tf                     # Terraform & provider versions
│   ├── locals.tf                       # Local computed values
│   ├── terraform.tfvars.example        # Example variable values
│   └── README.md                       # Infrastructure documentation
├── src/                                # Next.js source code
│   ├── app/                            # App Router (pages, layouts, API)
│   │   ├── layout.tsx                  # Root layout with Geist fonts
│   │   ├── page.tsx                    # Home page - Create session
│   │   ├── globals.css                 # Global styles + Tailwind @theme
│   │   ├── interview/
│   │   │   └── [id]/
│   │   │       └── page.tsx            # Interview room
│   │   ├── results/
│   │   │   └── [id]/
│   │   │       └── page.tsx            # Results dashboard
│   │   └── api/
│   │       ├── sessions/
│   │       │   └── route.ts            # Session CRUD
│   │       ├── questions/
│   │       │   └── route.ts            # Generate questions
│   │       ├── evaluate/
│   │       │   └── route.ts            # Evaluate responses
│   │       └── speech/
│   │           └── token/
│   │               └── route.ts        # Get speech auth token
│   ├── components/
│   │   ├── ui/                         # shadcn/ui components
│   │   ├── SessionForm.tsx             # Role & job description input
│   │   ├── InterviewRoom.tsx           # Main interview interface
│   │   ├── AudioRecorder.tsx           # Recording with timer (1-10 min)
│   │   ├── CountdownTimer.tsx          # Visual countdown component
│   │   ├── QuestionPlayer.tsx          # TTS playback
│   │   ├── ResultsChart.tsx            # Score visualization
│   │   └── FeedbackCard.tsx            # Feedback display
│   ├── lib/
│   │   ├── azure-openai.ts             # OpenAI client & helpers
│   │   ├── azure-speech.ts             # Speech service utilities
│   │   ├── prompts.ts                  # AI prompt templates
│   │   └── utils.ts                    # Utility functions
│   ├── actions/
│   │   ├── generate-questions.ts       # Server Action for questions
│   │   └── evaluate-responses.ts       # Server Action for evaluation
│   └── types/
│       ├── interview.ts                # Interview domain types
│       ├── api.ts                      # API request/response types
│       └── index.ts                    # Type re-exports
├── public/                             # Static assets
│   ├── next.svg
│   └── vercel.svg
├── .env.local.example                  # Environment variables template
├── .gitignore
├── eslint.config.mjs                   # ESLint 9 flat config
├── next.config.ts                      # Next.js configuration
├── next-env.d.ts                       # Next.js TypeScript declarations
├── package.json
├── pnpm-lock.yaml
├── postcss.config.mjs                  # PostCSS with Tailwind 4
├── tsconfig.json                       # TypeScript configuration
└── README.md                           # This file
```

### Folder Organization Rationale

| Folder | Purpose |
|--------|---------|
| `infra/` | Terraform IaC for Azure resources (kept at root for clear separation) |
| `src/` | All Next.js application code (cleaner root directory) |
| `public/` | Static assets (must remain at root for Next.js) |

### Key Configuration Files (Next.js 16)

#### `postcss.config.mjs` - Tailwind 4
```javascript
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
export default config;
```

#### `src/app/globals.css` - Tailwind 4 Theme
```css
@import "tailwindcss";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}
```

#### `tsconfig.json` - Path Alias Configuration
```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "infra"]
}
```

#### `eslint.config.mjs` - ESLint 9 Flat Config
```javascript
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default eslintConfig;
```

---

## 🎯 Seniority-Based Question Generation

### ⚠️ Session Inputs

When creating an interview session, users provide the following fields:

| Field | Description | Example | Validation |
|-------|-------------|---------|------------|
| **Role Title** | The target position with seniority level | "Senior FullStack .NET/Angular Developer" | ✅ Required, min 10 characters |
| **Company Name** | The company you're interviewing for | "Google", "Microsoft", "Amazon" | ⚪ Optional |
| **Job Description** | Full job posting or key responsibilities | "Design and implement scalable APIs..." | ✅ Required, min 50 characters |

> **Note:** Role Title and Job Description are mandatory. The Company Name is optional but can help tailor questions to the company's culture and tech stack.

> **Important:** Both fields are mandatory. The system will not generate questions without a complete role title and job description. The seniority level (Junior, Mid, Senior) is extracted from the role title to ensure questions match the expected competency level.

### Question Distribution Logic

Questions are generated to match the specified seniority level:

| Target Seniority | Senior Questions | Semi-Senior Questions | Junior Questions |
|------------------|------------------|----------------------|------------------|
| **Junior** | 0% | 20% | 80% |
| **Semi-Senior/Mid** | 20% | 60% | 20% |
| **Senior** | 70-80% | 20-30% | 0% |

### Example: Senior FullStack .NET/Angular

For a **Senior FullStack .NET/Angular Developer** role, the question distribution would be:

```
┌────────────────────────────────────────────────────────────┐
│                  10 INTERVIEW QUESTIONS                    │
├────────────────────────────────────────────────────────────┤
│  ████████████████████████████████████████ 70-80% Senior    │
│  ████████████                            20-30% Semi-Senior│
│                                           0% Junior        │
└────────────────────────────────────────────────────────────┘
```

### Question Categories & Response Time Limits

Each question category has a recommended response time based on **real interview scenarios**:

| Category | Description | Examples | Time Limit | Rationale |
|----------|-------------|----------|------------|-----------|
| **Technical** | Deep-dive into specific technologies | ".NET Core DI, Angular signals, RxJS" | ⏱️ 1-4 min | Direct answers with depth |
| **System Design** | Architecture and scalability | "Design a real-time notification system" | ⏱️ 5-10 min | Condensed version of real 30-45 min interviews |
| **Behavioral** | Leadership, communication, problem-solving | "Describe a technical decision you influenced" | ⏱️ 2-5 min | Full STAR method response |
| **Problem Solving** | Algorithmic thinking and debugging | "How would you optimize this query?" | ⏱️ 2-6 min | Explain approach + solution |

### ⏱️ Response Time Constraints

| Constraint | Value | Description |
|------------|-------|-------------|
| **Minimum** | 60 seconds (1 min) | Ensures meaningful, complete responses |
| **Maximum** | 600 seconds (10 min) | Allows thorough System Design answers |
| **Default** | 240 seconds (4 min) | Standard for most technical questions |

> **Why 10 minutes max?** In real interviews, System Design questions take 30-45 minutes. Since this is a practice tool where users prepare answers beforehand, 10 minutes allows for a condensed but realistic response covering: requirements clarification, high-level design, key components, and trade-offs.

> **How it works:** When the user presses the "Start Recording" button, a visible countdown timer begins on screen. The recording automatically stops when the time limit is reached, or the user can manually stop it earlier. The system saves whatever the user managed to say within the time limit.

### Question Generation Prompt

The AI uses this structured prompt to generate seniority-aligned questions:

```typescript
const systemPrompt = `You are a technical interview expert specializing in software engineering roles.

CRITICAL RULES:
1. Questions MUST align with the seniority level specified in the role title
2. For Senior roles: 70-80% Senior-level questions, 20-30% Semi-Senior, 0% Junior
3. For Mid-level roles: 20% Senior, 60% Mid-level, 20% Junior  
4. For Junior roles: 0% Senior, 20% Mid-level, 80% Junior
5. Senior questions should test: architecture decisions, system design, leadership, mentoring
6. Never include junior-level questions for senior positions

Generate 10 interview questions based on the role and job description provided.

Output JSON format:
{
  "questions": [
    {
      "id": 1,
      "question": "...",
      "difficulty": "senior|mid|junior",
      "category": "technical|behavioral|system-design|problem-solving",
      "expectedTopics": ["topic1", "topic2"],
      "timeLimit": 240 // seconds (min: 60, max: 600)
    }
  ]
}

Time limit guidelines by category:
- technical: 60-240 seconds (1-4 min)
- system-design: 300-600 seconds (5-10 min)
- behavioral: 120-300 seconds (2-5 min)
- problem-solving: 120-360 seconds (2-6 min)`;
```

---

## 📊 Evaluation Metrics

### Scoring System (100 Points Total)

| Metric | Weight | Description |
|--------|--------|-------------|
| **Relevance** | 25% | How well the answer addresses the specific question asked |
| **Technical Accuracy** | 25% | Correctness of technical concepts, terminology, and best practices |
| **Clarity** | 20% | Clear, concise communication without rambling or tangents |
| **Depth** | 15% | Level of detail, thoroughness, and real-world examples |
| **Structure** | 10% | Logical organization (problem → approach → solution) |
| **Confidence** | 5% | Speech fluency, minimal filler words ("um", "uh", "like") |

### Performance Bands

| Score Range | Rating | Description | Hiring Signal |
|-------------|--------|-------------|---------------|
| 90-100 | 🌟 **Excellent** | Exceptional responses demonstrating mastery | Strong hire |
| 75-89 | ✅ **Good** | Solid answers with minor gaps | Hire with minor concerns |
| 60-74 | ⚠️ **Satisfactory** | Adequate but needs improvement | Consider with reservations |
| 40-59 | 📝 **Needs Work** | Significant gaps in knowledge or communication | Not ready |
| 0-39 | ❌ **Poor** | Major deficiencies requiring substantial preparation | Major concerns |

### Evaluation Prompt Template

```typescript
const evaluationPrompt = `You are an expert technical interviewer evaluating a candidate response.

CONTEXT:
- Role: {role}
- Seniority Expected: {seniority}
- Question: {question}
- Expected Topics: {expectedTopics}
- Candidate Response: {transcribedResponse}

EVALUATION CRITERIA:
Score each criterion from 0-100:

1. Relevance (25%): Does the answer directly address what was asked?
2. Technical Accuracy (25%): Are concepts, terminology, and best practices correct?
3. Clarity (20%): Is the answer clear, concise, and well-articulated?
4. Depth (15%): Does it show real-world experience and thorough understanding?
5. Structure (10%): Is there a logical flow (context → approach → outcome)?
6. Confidence (5%): Is speech fluent with minimal filler words?

SENIORITY EXPECTATIONS:
- For Senior roles: Expect architectural thinking, leadership examples, mentoring mentions
- For Mid-level roles: Expect solid technical execution and problem-solving
- For Junior roles: Expect foundational knowledge and learning attitude

Output JSON:
{
  "scores": {
    "relevance": 85,
    "technicalAccuracy": 90,
    "clarity": 75,
    "depth": 80,
    "structure": 70,
    "confidence": 85
  },
  "overallScore": 82,
  "performanceBand": "good",
  "feedback": {
    "strengths": ["Clear explanation of...", "Good use of..."],
    "improvements": ["Could elaborate more on...", "Consider mentioning..."],
    "suggestion": "To strengthen this answer, try using the STAR method..."
  }
}`;
```

---

## 📡 API Reference

### Session Management

#### Create Session

```http
POST /api/sessions
Content-Type: application/json

{
  "roleTitle": "Senior FullStack .NET/Angular Developer",
  "companyName": "Google",  // Optional
  "jobDescription": "We are looking for a Senior FullStack Developer..."
}
```

**Response:**
```json
{
  "id": "sess_abc123",
  "roleTitle": "Senior FullStack .NET/Angular Developer",
  "companyName": "Google",
  "seniorityLevel": "senior",
  "createdAt": "2024-12-14T10:00:00Z",
  "status": "in-progress"
}
```
```

### Question Generation

#### Generate Questions

```http
POST /api/questions
Content-Type: application/json

{
  "sessionId": "sess_abc123",
  "role": "Senior FullStack .NET/Angular Developer",
  "jobDescription": "...",
  "seniority": "senior"
}
```

**Response:**
```json
{
  "questions": [
    {
      "id": 1,
      "question": "Describe how you would architect a microservices-based solution for a high-traffic e-commerce platform using .NET Core...",
      "difficulty": "senior",
      "category": "system-design",
      "expectedTopics": ["microservices", "API Gateway", "event-driven", "CQRS"],
      "timeLimit": 600
    }
  ]
}
```

> **Note:** `timeLimit` is in seconds. System Design questions get up to 600s (10 min) to allow for comprehensive architectural explanations, while Technical questions typically get 60-240s (1-4 min).

### Speech Token

#### Get Token for Browser SDK

```http
GET /api/speech/token
```

**Response:**
```json
{
  "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJS...",
  "region": "eastus",
  "expiresAt": "2024-12-14T10:10:00Z"
}
```

### Evaluation

#### Evaluate Responses

```http
POST /api/evaluate
Content-Type: application/json

{
  "sessionId": "sess_abc123",
  "responses": [
    {
      "questionId": 1,
      "transcription": "For a high-traffic e-commerce platform, I would design..."
    }
  ]
}
```

**Response:**
```json
{
  "sessionId": "sess_abc123",
  "overallScore": 78,
  "performanceBand": "good",
  "evaluations": [
    {
      "questionId": 1,
      "scores": {
        "relevance": 85,
        "technicalAccuracy": 82,
        "clarity": 75,
        "depth": 78,
        "structure": 70,
        "confidence": 80
      },
      "overallScore": 79,
      "feedback": {
        "strengths": ["Good understanding of microservices patterns"],
        "improvements": ["Could mention specific .NET libraries"],
        "suggestion": "Consider discussing containerization with Docker/K8s"
      }
    }
  ]
}
```

---

## 💰 Cost Estimation

### Development/Testing (MVP)

| Service | Monthly Usage | Estimated Cost |
|---------|---------------|----------------|
| Azure OpenAI (GPT-4o-mini) | ~500K tokens | ~$0.50 |
| Azure Speech (TTS) | ~100K characters | Free tier |
| Azure Speech (STT) | ~2 hours audio | Free tier |
| **Total** | | **~$0.50-1.00/month** |

### Production (per 100 users/month)

| Service | Monthly Usage | Estimated Cost |
|---------|---------------|----------------|
| Azure OpenAI (GPT-4o-mini) | ~5M tokens | ~$5 |
| Azure Speech (TTS) | ~1M characters | ~$15 |
| Azure Speech (STT) | ~20 hours audio | ~$20 |
| **Total** | | **~$40/month** |

### Free Tier Limits

| Service | Free Allocation |
|---------|-----------------|
| Azure Speech (TTS) | 0.5M characters/month |
| Azure Speech (STT) | 5 hours audio/month |
| Azure OpenAI | Pay-as-you-go only |

### Cost Optimization Tips

1. **Use GPT-4o-mini** instead of GPT-4o for 90% cost reduction
2. **Cache common questions** for repeated roles
3. **Implement token counting** and set usage limits
4. **Use shorter, focused prompts** to reduce token usage
5. **Compress audio** before sending to STT

---

## 🗺️ Roadmap

### Phase 1: Core MVP ✅
- [x] Project architecture design
- [x] Next.js 16 project setup with TypeScript
- [ ] Session creation with role & job description (mandatory fields)
- [ ] Azure OpenAI integration for question generation
- [ ] Seniority-aligned question logic
- [ ] **Countdown timer per question (1-10 min based on category)**
- [ ] Azure TTS for reading questions
- [ ] Azure STT for recording responses with auto-stop
- [ ] Basic evaluation with scoring
- [ ] Results display

### Phase 2: Enhanced Experience
- [ ] Audio waveform visualization
- [ ] Response playback feature
- [ ] Detailed feedback with charts
- [ ] Export results as PDF
- [ ] Dark/light theme support
- [ ] Pause/resume recording

### Phase 3: Advanced Features
- [ ] Multiple interview modes (behavioral, coding, system design)
- [ ] Practice history and progress tracking
- [ ] Custom question banks
- [ ] Real-time coaching during responses
- [ ] Multi-language support
- [ ] Team/enterprise features

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Development Guidelines

- Follow TypeScript best practices
- Use Server Components where possible
- Write meaningful commit messages
- Add tests for new features
- Update documentation as needed

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [Microsoft Azure AI Services](https://azure.microsoft.com/en-us/products/ai-services/) for powerful AI capabilities
- [Next.js](https://nextjs.org/) for the amazing React framework
- [Vercel](https://vercel.com/) for the Geist font family
- [shadcn/ui](https://ui.shadcn.com/) for beautiful UI components
- [Tailwind CSS](https://tailwindcss.com/) v4 for utility-first styling

---

<div align="center">

**Built with ❤️ using Azure AI Services and Next.js 16**

[⬆ Back to Top](#️-ai-tech-interview---voice-powered-interview-preparation-platform)

</div>
