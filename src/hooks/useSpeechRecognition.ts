// =========================================================================
// AI Tech Interview - Speech Recognition Hook
// Speech-to-text using Azure Cognitive Services Speech SDK
// =========================================================================

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';

// =========================================================================
// Types
// =========================================================================

export type RecognitionStatus = 'idle' | 'loading' | 'listening' | 'processing' | 'error';

export interface SpeechRecognitionState {
  status: RecognitionStatus;
  transcript: string;
  interimTranscript: string;
  error: string | null;
}

export interface UseSpeechRecognitionReturn {
  state: SpeechRecognitionState;
  startListening: () => Promise<void>;
  stopListening: () => Promise<string>;
  resetTranscript: () => void;
  isSupported: boolean;
}

interface SpeechToken {
  token: string;
  region: string;
  expiresAt: string;
}

// =========================================================================
// Token Management
// =========================================================================

let cachedToken: SpeechToken | null = null;

async function getSpeechToken(): Promise<SpeechToken> {
  // Check if we have a valid cached token (with 1 min buffer)
  if (cachedToken) {
    const expiresAt = new Date(cachedToken.expiresAt);
    const bufferTime = 60 * 1000; // 1 minute buffer
    if (expiresAt.getTime() - bufferTime > Date.now()) {
      return cachedToken;
    }
  }

  // Fetch new token
  const response = await fetch('/api/speech/token');
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Failed to get speech token');
  }

  const data = await response.json();
  cachedToken = data.data;
  return cachedToken!;
}

// =========================================================================
// Hook Implementation
// =========================================================================

export function useSpeechRecognition(): UseSpeechRecognitionReturn {
  const [state, setState] = useState<SpeechRecognitionState>({
    status: 'idle',
    transcript: '',
    interimTranscript: '',
    error: null,
  });

  const recognizerRef = useRef<SpeechSDK.SpeechRecognizer | null>(null);
  const sdkRef = useRef<typeof SpeechSDK | null>(null);
  const transcriptRef = useRef<string>('');

  // Check browser support
  const isSupported = typeof window !== 'undefined' && 
    'mediaDevices' in navigator &&
    typeof AudioContext !== 'undefined';

  // Lazy load the Speech SDK
  const loadSdk = useCallback(async (): Promise<typeof SpeechSDK> => {
    if (sdkRef.current) return sdkRef.current;

    // Dynamic import of the Speech SDK
    const sdk = await import('microsoft-cognitiveservices-speech-sdk');
    sdkRef.current = sdk;
    return sdk;
  }, []);

  // Initialize recognizer
  const initializeRecognizer = useCallback(async () => {
    try {
      const sdk = await loadSdk();
      const tokenData = await getSpeechToken();

      // Create speech config from auth token
      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(
        tokenData.token,
        tokenData.region
      );

      // Configure recognition
      speechConfig.speechRecognitionLanguage = 'en-US';
      speechConfig.enableDictation();

      // Create audio config from default microphone
      const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();

      // Create recognizer
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      // Set up event handlers
      recognizer.recognizing = (
        _sender: SpeechSDK.Recognizer,
        event: SpeechSDK.SpeechRecognitionEventArgs
      ) => {
        // Interim results
        setState((prev) => ({
          ...prev,
          interimTranscript: event.result.text,
        }));
      };

      recognizer.recognized = (
        _sender: SpeechSDK.Recognizer,
        event: SpeechSDK.SpeechRecognitionEventArgs
      ) => {
        if (event.result.reason === sdk.ResultReason.RecognizedSpeech) {
          const text = event.result.text;
          if (text) {
            transcriptRef.current += (transcriptRef.current ? ' ' : '') + text;
            setState((prev) => ({
              ...prev,
              transcript: transcriptRef.current,
              interimTranscript: '',
            }));
          }
        }
      };

      recognizer.canceled = (
        _sender: SpeechSDK.Recognizer,
        event: SpeechSDK.SpeechRecognitionCanceledEventArgs
      ) => {
        if (event.reason === sdk.CancellationReason.Error) {
          console.error('Speech recognition error:', event.errorDetails);
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: event.errorDetails || 'Speech recognition failed',
          }));
        }
      };

      recognizer.sessionStopped = () => {
        setState((prev) => ({
          ...prev,
          status: 'idle',
          interimTranscript: '',
        }));
      };

      recognizerRef.current = recognizer;
      return recognizer;
    } catch (error) {
      console.error('Failed to initialize speech recognizer:', error);
      throw error;
    }
  }, [loadSdk]);

  // Start listening
  const startListening = useCallback(async () => {
    if (!isSupported) {
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: 'Speech recognition is not supported in this browser',
      }));
      return;
    }

    try {
      setState((prev) => ({
        ...prev,
        status: 'loading',
        error: null,
      }));

      // Reset transcript
      transcriptRef.current = '';
      setState((prev) => ({
        ...prev,
        transcript: '',
        interimTranscript: '',
      }));

      // Initialize or reuse recognizer
      let recognizer = recognizerRef.current;
      if (!recognizer) {
        recognizer = await initializeRecognizer();
      }

      // Start continuous recognition
      await new Promise<void>((resolve, reject) => {
        recognizer!.startContinuousRecognitionAsync(
          () => {
            setState((prev) => ({ ...prev, status: 'listening' }));
            resolve();
          },
          (error) => {
            console.error('Failed to start recognition:', error);
            setState((prev) => ({
              ...prev,
              status: 'error',
              error: error || 'Failed to start speech recognition',
            }));
            reject(new Error(error));
          }
        );
      });
    } catch (error) {
      console.error('Failed to start listening:', error);
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to start listening',
      }));
    }
  }, [isSupported, initializeRecognizer]);

  // Stop listening
  const stopListening = useCallback(async (): Promise<string> => {
    return new Promise((resolve) => {
      if (!recognizerRef.current || state.status !== 'listening') {
        resolve(transcriptRef.current);
        return;
      }

      setState((prev) => ({ ...prev, status: 'processing' }));

      recognizerRef.current.stopContinuousRecognitionAsync(
        () => {
          setState((prev) => ({
            ...prev,
            status: 'idle',
            interimTranscript: '',
          }));
          resolve(transcriptRef.current);
        },
        (error) => {
          console.error('Failed to stop recognition:', error);
          setState((prev) => ({
            ...prev,
            status: 'idle',
            interimTranscript: '',
          }));
          resolve(transcriptRef.current);
        }
      );
    });
  }, [state.status]);

  // Reset transcript
  const resetTranscript = useCallback(() => {
    transcriptRef.current = '';
    setState((prev) => ({
      ...prev,
      transcript: '',
      interimTranscript: '',
      error: null,
    }));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognizerRef.current) {
        recognizerRef.current.close();
      }
    };
  }, []);

  return {
    state,
    startListening,
    stopListening,
    resetTranscript,
    isSupported,
  };
}
