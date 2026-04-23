/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        brand: {
          dark:  '#14746F',
          mid:   '#248277',
          light: '#56AB91',
          mint:  '#99E2B4',
        },
        ink:    '#242323',
        offwhite: '#F8F8F8',
        border: '#E2E2E2',
      },
      fontFamily: {
        display: ['Montserrat', 'sans-serif'],
        body:    ['Inter', 'sans-serif'],
      },
      fontSize: {
        'display-xl': ['60px', { lineHeight: '1.1',  letterSpacing: '-0.5px' }],
        'display-lg': ['44px', { lineHeight: '1.15', letterSpacing: '-0.3px' }],
        'display-md': ['28px', { lineHeight: '1.25', letterSpacing: '0px'    }],
        'stat':       ['52px', { lineHeight: '1',    letterSpacing: '-1px'   }],
      },
      spacing: {
        18: '72px',
        22: '88px',
        30: '120px',
      },
      borderRadius: {
        card: '10px',
      },
      boxShadow: {
        card: '0 4px 20px rgba(20, 116, 111, 0.10)',
        nav:  '0 2px 16px rgba(0,0,0,0.08)',
      },
      maxWidth: {
        content: '1200px',
      },
    },
  },
  plugins: [],
}
