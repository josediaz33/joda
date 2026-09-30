import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { mfaConfirmEnrollInput } from "@joda/contracts";
import { Button } from "@joda/ui/primitives/button";
import { api } from "../api";
import { useLogout, useRefreshSession } from "../session";

export default function Enroll() {
  const [code, setCode] = useState("");
  const [validation, setValidation] = useState("");
  const refreshSession = useRefreshSession();
  const logout = useLogout();
  const enrollment = useMutation({ mutationFn: api.enroll });
  const confirmation = useMutation({ mutationFn: api.confirmEnroll, onSuccess: refreshSession });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = mfaConfirmEnrollInput.safeParse({ code });
    if (!result.success) {
      setValidation("Ingresá los 6 dígitos de tu aplicación autenticadora.");
      return;
    }
    setValidation("");
    confirmation.mutate(result.data.code);
  }

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <p className="font-display text-heading-sm uppercase">JODA / Admin</p>
      <h1 className="mt-8 font-display text-heading-md">Inscribir segundo factor</h1>
      <p className="mt-2 text-text-secondary">
        Para acceder al admin, vinculá una aplicación autenticadora a tu cuenta.
      </p>
      {!enrollment.data ? (
        <Button
          className="mt-8"
          disabled={enrollment.isPending}
          onClick={() => enrollment.mutate()}
        >
          Generar clave de inscripción
        </Button>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="border border-border-subtle bg-surface-elevated p-4">
            <p className="text-sm font-semibold">
              Abrí la aplicación autenticadora e ingresá esta clave:
            </p>
            <code className="mt-2 block break-all font-mono text-lg">{enrollment.data.secret}</code>
            <a
              className="mt-3 block text-sm text-accent underline"
              href={enrollment.data.otpauthUri}
            >
              Abrir en la aplicación autenticadora
            </a>
          </div>
          <form onSubmit={submit}>
            <label htmlFor="code" className="mb-1 block text-sm font-semibold">
              Código de 6 dígitos
            </label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-describedby="mfa-error"
              className="block w-full rounded-control border border-border-strong px-3 py-2 focus-visible:outline-2 focus-visible:outline-focus"
            />
            <p id="mfa-error" role="alert" className="mt-2 text-sm text-error">
              {validation || confirmation.error?.message}
            </p>
            <Button className="mt-4" type="submit" disabled={confirmation.isPending}>
              Confirmar inscripción
            </Button>
          </form>
        </div>
      )}
      {enrollment.isError && (
        <p role="alert" className="mt-4 text-error">
          {enrollment.error.message}
        </p>
      )}
      <Button className="mt-8" variant="ghost" onClick={() => logout.mutate()}>
        Salir
      </Button>
    </main>
  );
}
