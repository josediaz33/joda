import { lazy, Suspense } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Button } from "@joda/ui/primitives/button";
import type { PermissionCode } from "@joda/contracts";
import { Can } from "./Can";
import { useLogout, useSession } from "./session";

const Login = lazy(() => import("./routes/Login"));
const Enroll = lazy(() => import("./routes/Enroll"));
const Verify = lazy(() => import("./routes/Verify"));
const Home = lazy(() => import("./routes/Home"));
const CatalogPreview = lazy(() => import("./routes/CatalogPreview"));
const Categories = lazy(() => import("./routes/Categories"));
const Accounting = lazy(() => import("./routes/Accounting"));

function Loading() {
  return <main className="p-8 text-text-secondary">Cargando…</main>;
}

function SessionBoundary() {
  const session = useSession();
  const location = useLocation();
  const logout = useLogout();

  if (session.isPending) return <Loading />;
  if (session.isError && !session.isUnauthenticated) {
    return (
      <main className="mx-auto max-w-lg p-8">
        <h1 className="font-display text-heading-md">No se pudo cargar la sesión</h1>
        <p className="mb-4 text-text-secondary">Comprobá la conexión e intentá de nuevo.</p>
        <Button onClick={() => void session.refetch()}>Reintentar</Button>
      </main>
    );
  }
  if (!session.data) {
    return (
      <Routes>
        <Route path="/ingresar" element={<Login />} />
        <Route path="*" element={<Navigate to="/ingresar" state={{ from: location }} replace />} />
      </Routes>
    );
  }

  if (session.data.profile.mfaStatus === "pending_enrollment") {
    return (
      <Routes>
        <Route path="/inscribir-mfa" element={<Enroll />} />
        <Route path="*" element={<Navigate to="/inscribir-mfa" replace />} />
      </Routes>
    );
  }
  if (session.data.profile.mfaStatus === "pending_verification") {
    return (
      <Routes>
        <Route path="/verificar-mfa" element={<Verify />} />
        <Route path="*" element={<Navigate to="/verificar-mfa" replace />} />
      </Routes>
    );
  }

  return (
    <div className="min-h-screen bg-surface text-text">
      <header className="border-b border-border-subtle bg-surface-elevated">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <Link to="/" className="font-display text-heading-sm uppercase tracking-tight">
            JODA / Admin
          </Link>
          <nav aria-label="Principal" className="flex flex-wrap items-center gap-5 text-sm">
            <Link to="/">Inicio</Link>
            <Can perform="catalog.product:read">
              <Link to="/vista-catalogo">Catálogo</Link>
              <Link to="/categorias">Categorías</Link>
            </Can>
            <Can perform="accounting.journal:read">
              <Link to="/contabilidad">Contabilidad</Link>
            </Can>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-text-secondary sm:inline">
              {session.data.profile.fullName}
            </span>
            {logout.isError && (
              <span role="alert" className="text-error">
                No se pudo cerrar la sesión.
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              Salir
            </Button>
          </div>
        </div>
      </header>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route
            path="/vista-catalogo"
            element={
              <Guard perform="catalog.product:read">
                <CatalogPreview />
              </Guard>
            }
          />
          <Route
            path="/categorias"
            element={
              <Guard perform="catalog.product:read">
                <Categories />
              </Guard>
            }
          />
          <Route
            path="/contabilidad"
            element={
              <Guard perform="accounting.journal:read">
                <Accounting />
              </Guard>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
}

function Guard({ perform, children }: { perform: PermissionCode; children: React.ReactNode }) {
  return (
    <Can perform={perform} fallback={<Navigate to="/" replace />}>
      {children}
    </Can>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
        <SessionBoundary />
      </Suspense>
    </BrowserRouter>
  );
}
