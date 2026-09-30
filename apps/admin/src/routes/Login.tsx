import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { staffLoginInput } from "@joda/contracts";
import { Button } from "@joda/ui/primitives/button";
import { api } from "../api";
import { useRefreshSession } from "../session";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [validation, setValidation] = useState("");
  const refreshSession = useRefreshSession();
  const login = useMutation({ mutationFn: api.login, onSuccess: refreshSession });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = staffLoginInput.safeParse({ email, password });
    if (!result.success) {
      setValidation("Ingresá un email válido y la contraseña.");
      return;
    }
    setValidation("");
    login.mutate(result.data);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-elevated px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm border border-border-subtle bg-surface p-8"
      >
        <p className="font-display text-heading-sm uppercase">JODA / Admin</p>
        <h1 className="mt-8 font-display text-heading-md">Ingresar</h1>
        <p className="mb-8 text-sm text-text-secondary">Acceso para el equipo de JODA Parfums.</p>
        <label htmlFor="email" className="mb-1 block text-sm font-semibold">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mb-4 w-full rounded-control border border-border-strong px-3 py-2 focus-visible:outline-2 focus-visible:outline-focus"
        />
        <label htmlFor="password" className="mb-1 block text-sm font-semibold">
          Contraseña
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mb-5 w-full rounded-control border border-border-strong px-3 py-2 focus-visible:outline-2 focus-visible:outline-focus"
        />
        {(validation || login.isError) && (
          <p role="alert" className="mb-4 text-sm text-error">
            {validation || login.error?.message || "No se pudo ingresar."}
          </p>
        )}
        <Button type="submit" disabled={login.isPending} className="w-full">
          {login.isPending ? "Ingresando…" : "Ingresar"}
        </Button>
      </form>
    </main>
  );
}
