// =========================================================================
// AI Tech Interview - Speech Synthesis Hook
// Text-to-speech using Azure Cognitive Services Speech SDK
// =========================================================================

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';

// =========================================================================
// Types
// =========================================================================

export type SpeechStatus = 'idle' | 'loading' | 'speaking' | 'paused' | 'error';

export interface SpeechSynthesisState {
  status: SpeechStatus;
  error: string | null;
  currentText: string | null;
}

export interface UseSpeechSynthesisReturn {
  state: SpeechSynthesisState;
  speak: (text: string) => Promise<void>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
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

export function useSpeechSynthesis(): UseSpeechSynthesisReturn {
  const [state, setState] = useState<SpeechSynthesisState>({
    status: 'idle',
    error: null,
    currentText: null,
  });

  const synthesizerRef = useRef<SpeechSDK.SpeechSynthesizer | null>(null);
  const playerRef = useRef<SpeechSDK.SpeakerAudioDestination | null>(null);
  const sdkRef = useRef<typeof SpeechSDK | null>(null);

  // Check browser support
  const isSupported = typeof window !== 'undefined' && typeof AudioContext !== 'undefined';

  // Lazy load the Speech SDK
  const loadSdk = useCallback(async (): Promise<typeof SpeechSDK> => {
    if (sdkRef.current) return sdkRef.current;

    // Dynamic import of the Speech SDK
    const sdk = await import('microsoft-cognitiveservices-speech-sdk');
    sdkRef.current = sdk;
    return sdk;
  }, []);

  // Initialize synthesizer
  const initializeSynthesizer = useCallback(async () => {
    try {
      const sdk = await loadSdk();
      const tokenData = await getSpeechToken();

      // Create speech config from auth token
      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(
        tokenData.token,
        tokenData.region
      );

      // Configure voice
      speechConfig.speechSynthesisVoiceName = 'en-US-AvaMultilingualNeural';
      speechConfig.speechSynthesisOutputFormat =
        sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

      // Create audio config with speaker output
      const player = new sdk.SpeakerAudioDestination();
      playerRef.current = player;

      const audioConfig = sdk.AudioConfig.fromSpeakerOutput(player);

      // Create synthesizer
      const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);
      synthesizerRef.current = synthesizer;

      return synthesizer;
    } catch (error) {
      console.error('Failed to initialize speech synthesizer:', error);
      throw error;
    }
  }, [loadSdk]);

  // Speak text
  const speak = useCallback(
    async (text: string) => {
      if (!isSupported) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: 'Speech synthesis is not supported in this browser',
        }));
        return;
      }

      try {
        setState({
          status: 'loading',
          error: null,
          currentText: text,
        });

        // Initialize or reuse synthesizer
        let synthesizer = synthesizerRef.current;
        if (!synthesizer) {
          synthesizer = await initializeSynthesizer();
        }

        setState((prev) => ({ ...prev, status: 'speaking' }));

        // Speak the text
        await new Promise<void>((resolve, reject) => {
          synthesizer!.speakTextAsync(
            text,
            (result: SpeechSDK.SpeechSynthesisResult) => {
              if (result.reason === sdkRef.current!.ResultReason.SynthesizingAudioCompleted) {
                setState((prev) => ({ ...prev, status: 'idle', currentText: null }));
                resolve();
              } else {
                const error = `Speech synthesis canceled: ${result.errorDetails}`;
                setState((prev) => ({
                  ...prev,
                  status: 'error',
                  error,
                }));
                reject(new Error(error));
              }
            },
            (error: string) => {
              console.error('Speech synthesis error:', error);
              setState((prev) => ({
                ...prev,
                status: 'error',
                error: error || 'Speech synthesis failed',
              }));
              reject(new Error(error));
            }
          );
        });
      } catch (error) {
        console.error('Failed to speak:', error);
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to speak',
        }));
      }
    },
    [isSupported, initializeSynthesizer]
  );

  // Stop speaking
  const stop = useCallback(() => {
    if (playerRef.current) {
      playerRef.current.pause();
      playerRef.current.close();
      playerRef.current = null;
    }

    // Close and recreate synthesizer
    if (synthesizerRef.current) {
      synthesizerRef.current.close();
      synthesizerRef.current = null;
    }

    setState({
      status: 'idle',
      error: null,
      currentText: null,
    });
  }, []);

  // Pause speaking
  const pause = useCallback(() => {
    if (playerRef.current && state.status === 'speaking') {
      playerRef.current.pause();
      setState((prev) => ({ ...prev, status: 'paused' }));
    }
  }, [state.status]);

  // Resume speaking
  const resume = useCallback(() => {
    if (playerRef.current && state.status === 'paused') {
      playerRef.current.resume();
      setState((prev) => ({ ...prev, status: 'speaking' }));
    }
  }, [state.status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (playerRef.current) {
        playerRef.current.close();
      }
      if (synthesizerRef.current) {
        synthesizerRef.current.close();
      }
    };
  }, []);

  return {
    state,
    speak,
    stop,
    pause,
    resume,
    isSupported,
  };
}
