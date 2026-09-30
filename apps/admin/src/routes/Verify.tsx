import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { mfaVerifyInput } from "@joda/contracts";
import { Button } from "@joda/ui/primitives/button";
import { api } from "../api";
import { useLogout, useRefreshSession } from "../session";

export default function Verify() {
  const [code, setCode] = useState("");
  const [validation, setValidation] = useState("");
  const refreshSession = useRefreshSession();
  const logout = useLogout();
  const verification = useMutation({ mutationFn: api.verify, onSuccess: refreshSession });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = mfaVerifyInput.safeParse({ code });
    if (!result.success) {
      setValidation("Ingresá los 6 dígitos de tu aplicación autenticadora.");
      return;
    }
    setValidation("");
    verification.mutate(result.data.code);
  }

  return (
    <main className="mx-auto max-w-md px-6 py-12">
      <p className="font-display text-heading-sm uppercase">JODA / Admin</p>
      <h1 className="mt-8 font-display text-heading-md">Verificar segundo factor</h1>
      <p className="mt-2 text-text-secondary">
        Ingresá el código actual de tu aplicación autenticadora.
      </p>
      <form onSubmit={submit} className="mt-8">
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
          {validation || verification.error?.message}
        </p>
        <Button className="mt-4" type="submit" disabled={verification.isPending}>
          Verificar
        </Button>
      </form>
      <Button className="mt-8" variant="ghost" onClick={() => logout.mutate()}>
        Salir
      </Button>
    </main>
  );
}
