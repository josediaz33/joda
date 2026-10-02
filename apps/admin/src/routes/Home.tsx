import { Link } from "react-router-dom";
import { Can } from "../Can";
import { useSession } from "../session";

export default function Home() {
  const session = useSession();
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <p className="text-sm text-text-secondary">Panel de trabajo</p>
      <h1 className="mt-2 font-display text-heading-lg">
        Buen día, {session.data?.profile.fullName}
      </h1>
      <p className="mt-2 max-w-2xl text-text-secondary">
        Seleccioná un área para continuar. Las opciones visibles corresponden a los permisos de tu
        sesión.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Can perform="catalog.product:read">
          <Link
            className="border border-border-subtle bg-surface-elevated p-6 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-focus"
            to="/vista-catalogo"
          >
            <span className="font-display text-heading-sm">Vista de catálogo</span>
            <span className="mt-2 block text-sm text-text-secondary">
              Consultar productos registrados.
            </span>
          </Link>
        </Can>
        <Can perform="accounting.journal:read">
          <Link
            className="border border-border-subtle bg-surface-elevated p-6 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-focus"
            to="/contabilidad"
          >
            <span className="font-display text-heading-sm">Contabilidad</span>
            <span className="mt-2 block text-sm text-text-secondary">
              Área reservada al personal autorizado.
            </span>
          </Link>
        </Can>
      </div>
    </main>
  );
}
