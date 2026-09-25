import type { ReactNode } from "react";
import "@joda/ui/tokens.css";

export const metadata = {
  title: "JODA Parfums",
  description: "Perfumería y relojería de nicho en Encarnación, Paraguay.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
