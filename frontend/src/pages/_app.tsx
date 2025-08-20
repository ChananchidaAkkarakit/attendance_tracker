// src/pages/_app.tsx
import "@/styles/globals.css";
import type { AppProps } from "next/app";
import { Kalnia, Kantumruy_Pro } from "next/font/google";

export const kalnia = Kalnia({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const kantumruy = Kantumruy_Pro({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
