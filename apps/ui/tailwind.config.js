/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bitcoin: '#f7931a',
      },
    },
  },
  plugins: [
    function({ addVariant }) {
      addVariant('light', ':is(.light &)')
    }
  ],
}
