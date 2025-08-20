/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}", // คุณใช้โครงสร้าง src/
    "./pages/**/*.{js,ts,jsx,tsx}"    // เผื่อมีไฟล์นอก src
  ],
  theme: { extend: {} },
  plugins: []
}
