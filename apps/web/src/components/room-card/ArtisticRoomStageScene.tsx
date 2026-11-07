"use client";

import type { RoomType } from "@soqaro/shared";

type ArtisticRoomStageSceneProps = {
  roomType: RoomType;
  className?: string;
};

export function ArtisticRoomStageScene({ roomType, className = "" }: ArtisticRoomStageSceneProps) {
  if (roomType === "request") return <RequestNebulaVinylScene className={className} />;
  if (roomType === "radio") return <RadioAuroraPulseScene className={className} />;
  return <InteractiveStarfieldScene className={className} />;
}

/**
 * 1. Interactive Room Scene: Geometric Soundwaves & Audio Spectrum
 */
export function InteractiveStarfieldScene({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`relative w-full h-full overflow-hidden bg-slate-100 dark:bg-[#0b0e14] select-none [contain:layout_paint] ${className}`}
    >
      {/* Crisp Geometric Soundwaves */}
      <svg
        className="absolute inset-0 w-full h-full text-blue-600/30 dark:text-blue-400/25 pointer-events-none"
        preserveAspectRatio="none"
        viewBox="0 0 320 140"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M -10 70 Q 70 30, 160 70 T 330 70"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M -10 50 Q 80 85, 170 45 T 330 60"
          fill="none"
          stroke="currentColor"
          strokeDasharray="4 4"
          strokeWidth="1"
          className="opacity-70"
        />
        <path
          d="M -10 90 Q 90 60, 180 95 T 330 80"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          className="opacity-50"
        />
      </svg>

      {/* Understated Minimal Horizon Grid */}
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-slate-200/50 to-transparent dark:from-[#07090e] dark:to-transparent pointer-events-none" />
    </div>
  );
}

/**
 * 2. Request Room Scene: Clean Vinyl Record
 */
export function RequestNebulaVinylScene({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`relative w-full h-full overflow-hidden bg-slate-100 dark:bg-[#0e0c13] select-none [contain:layout_paint] ${className}`}
    >
      {/* Vinyl Record */}
      <div className="absolute -right-4 -bottom-8 w-40 h-40 sm:w-44 sm:h-44 transition-transform duration-500 ease-out group-hover:scale-105">
        <svg
          viewBox="0 0 160 160"
          className="w-full h-full drop-shadow-sm group-hover:animate-spin-slow full-motion-spin group-hover:will-change-transform"
        >
          <defs>
            <linearGradient id="vinylBody" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#222026" />
              <stop offset="50%" stopColor="#141317" />
              <stop offset="100%" stopColor="#1a181e" />
            </linearGradient>
            <linearGradient id="specularWedge" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.12)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </linearGradient>
          </defs>

          {/* Vinyl Disc Body */}
          <circle cx="80" cy="80" r="76" fill="url(#vinylBody)" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />

          {/* Concentric Sound Grooves */}
          <circle cx="80" cy="80" r="68" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.75" />
          <circle cx="80" cy="80" r="56" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.75" />
          <circle cx="80" cy="80" r="44" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="0.75" />

          {/* Specular Reflective Highlight Wedges */}
          <path d="M 80,80 L 140,40 A 76,76 0 0,0 110,12 Z" fill="url(#specularWedge)" />
          <path d="M 80,80 L 20,120 A 76,76 0 0,0 50,148 Z" fill="url(#specularWedge)" />

          {/* Center Record Label */}
          <circle cx="80" cy="80" r="24" fill="#312e38" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
          <circle cx="80" cy="80" r="21" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />
          <circle cx="80" cy="80" r="6" fill="#141317" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
        </svg>
      </div>

      {/* Bottom Vignette */}
      <div className="absolute inset-0 bg-gradient-to-t from-slate-200/50 via-transparent to-transparent dark:from-[#0a080f]/80 pointer-events-none" />
    </div>
  );
}

/**
 * 3. Radio Room Scene: Concentric Broadcast Waves
 */
export function RadioAuroraPulseScene({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`relative w-full h-full overflow-hidden bg-slate-100 dark:bg-[#071113] select-none [contain:layout_paint] ${className}`}
    >
      {/* Concentric Radial Broadcast Waves */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none text-teal-600/35 dark:text-teal-400/25"
        preserveAspectRatio="none"
        viewBox="0 0 320 140"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle
          cx="50%"
          cy="50%"
          r="18%"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          className="opacity-70"
        />
        <circle
          cx="50%"
          cy="50%"
          r="34%"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="4 4"
          className="opacity-50"
        />
        <circle
          cx="50%"
          cy="50%"
          r="50%"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.75"
          className="opacity-30"
        />
      </svg>

      {/* Subtle Radio Tower Dot */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center pointer-events-none">
        <div className="w-6 h-6 rounded-full border border-teal-500/30 bg-teal-500/10 flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-teal-600 dark:bg-teal-400" />
        </div>
      </div>

      {/* Bottom Vignette */}
      <div className="absolute inset-0 bg-gradient-to-t from-slate-200/50 via-transparent to-transparent dark:from-[#050b0c]/80 pointer-events-none" />
    </div>
  );
}
