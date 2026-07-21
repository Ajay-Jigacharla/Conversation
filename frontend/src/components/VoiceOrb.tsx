/**
 * VoiceOrb.tsx — Animated microphone button
 * States: idle | recording | processing | playing
 */
import React from "react";

export type OrbState = "idle" | "recording" | "processing" | "playing";

interface VoiceOrbProps {
  state: OrbState;
  onClick: () => void;
  disabled?: boolean;
}

const ICONS: Record<OrbState, React.ReactNode> = {
  idle: (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm0 2a2 2 0 0 0-2 2v6a2 2 0 0 0 4 0V5a2 2 0 0 0-2-2zm-7 9h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.92V21h3v2H8v-2h3v-2.08A7 7 0 0 1 5 12z"/>
    </svg>
  ),
  recording: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2"/>
    </svg>
  ),
  processing: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" className="spin">
      <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z" opacity=".3"/>
      <path d="M20 12h2A10 10 0 0 0 12 2v2a8 8 0 0 1 8 8z"/>
    </svg>
  ),
  playing: (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
    </svg>
  ),
};

const LABELS: Record<OrbState, string> = {
  idle:       "Tap to speak",
  recording:  "Tap to stop",
  processing: "Processing…",
  playing:    "Playing…",
};

export const VoiceOrb: React.FC<VoiceOrbProps> = ({ state, onClick, disabled }) => {
  return (
    <div className="orb-container">
      {/* Outer ripple rings — only during recording */}
      {state === "recording" && (
        <>
          <div className="orb-ring ring-1" />
          <div className="orb-ring ring-2" />
          <div className="orb-ring ring-3" />
        </>
      )}

      {/* Playing breath ring */}
      {state === "playing" && <div className="orb-ring ring-play" />}

      <button
        className={`orb orb--${state}`}
        onClick={onClick}
        disabled={disabled || state === "processing"}
        aria-label={LABELS[state]}
      >
        {ICONS[state]}
      </button>

      <p className="orb-label">{LABELS[state]}</p>
    </div>
  );
};
