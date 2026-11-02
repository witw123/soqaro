import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["selector", '[data-theme-mode="dark"], [data-theme="dark"]'],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "PingFang SC", "Microsoft YaHei", "sans-serif"]
      },
      borderWidth: {
        DEFAULT: '0.5px',
        '0': '0px',
        '0.5': '0.5px',
        'hairline': '0.5px',
        '1': '1px',
        '2': '2px',
      },
      transitionDuration: {
        DEFAULT: '250ms',
        '150': '150ms',
        '200': '200ms',
        '250': '250ms',
      },
      transitionTimingFunction: {
        DEFAULT: 'cubic-bezier(0, 0, 0.2, 1)',
        'ease-out': 'cubic-bezier(0, 0, 0.2, 1)',
      },
      colors: {
        background: "var(--background)",
        "background-secondary": "var(--background-secondary)",
        foreground: "var(--foreground)",
        "foreground-muted": "var(--foreground-muted)",
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          subtle: "var(--accent-subtle)",
          muted: "var(--accent-muted)",
          glow: "var(--accent-glow)",
        },
        surface: {
          DEFAULT: "var(--surface)",
          hover: "var(--surface-hover)",
          active: "var(--surface-active)",
          border: "var(--surface-border)",
        },
        // Radix UI Colors palette reference
        radix: {
          slate: {
            1: "var(--slate-1)",
            2: "var(--slate-2)",
            3: "var(--slate-3)",
            4: "var(--slate-4)",
            5: "var(--slate-5)",
            6: "var(--slate-6)",
            7: "var(--slate-7)",
            8: "var(--slate-8)",
            9: "var(--slate-9)",
            10: "var(--slate-10)",
            11: "var(--slate-11)",
            12: "var(--slate-12)",
          },
                    blue: {
            1: "var(--blue-1)",
            2: "var(--blue-2)",
            3: "var(--blue-3)",
            4: "var(--blue-4)",
            5: "var(--blue-5)",
            6: "var(--blue-6)",
            7: "var(--blue-7)",
            8: "var(--blue-8)",
            9: "var(--blue-9)",
            10: "var(--blue-10)",
            11: "var(--blue-11)",
            12: "var(--blue-12)",
          },
          green: {
            1: "var(--green-1)",
            2: "var(--green-2)",
            3: "var(--green-3)",
            4: "var(--green-4)",
            5: "var(--green-5)",
            6: "var(--green-6)",
            7: "var(--green-7)",
            8: "var(--green-8)",
            9: "var(--green-9)",
            10: "var(--green-10)",
            11: "var(--green-11)",
            12: "var(--green-12)",
          },
          amber: {
            1: "var(--amber-1)",
            2: "var(--amber-2)",
            3: "var(--amber-3)",
            4: "var(--amber-4)",
            5: "var(--amber-5)",
            6: "var(--amber-6)",
            7: "var(--amber-7)",
            8: "var(--amber-8)",
            9: "var(--amber-9)",
            10: "var(--amber-10)",
            11: "var(--amber-11)",
            12: "var(--amber-12)",
          },
          red: {
            1: "var(--red-1)",
            2: "var(--red-2)",
            3: "var(--red-3)",
            4: "var(--red-4)",
            5: "var(--red-5)",
            6: "var(--red-6)",
            7: "var(--red-7)",
            8: "var(--red-8)",
            9: "var(--red-9)",
            10: "var(--red-10)",
            11: "var(--red-11)",
            12: "var(--red-12)",
          }
        }
      },
      animation: {
        'spin-slow': 'spin 8s linear infinite',
        'fade-in': 'fadeIn 250ms cubic-bezier(0, 0, 0.2, 1) forwards',
        'slide-up': 'slideUp 250ms cubic-bezier(0, 0, 0.2, 1) forwards',
        'music-bar': 'musicBar 1s ease-in-out infinite',
      },
      keyframes: {
        musicBar: {
          '0%, 100%': { transform: 'scaleY(0.25)' },
          '50%': { transform: 'scaleY(1)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        }
      }
    },
  },
  plugins: [],
};

export default config;
