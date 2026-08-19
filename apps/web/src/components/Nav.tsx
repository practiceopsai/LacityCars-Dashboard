"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api";

const LINKS = [
  { href: "/", label: "Command Center" },
  { href: "/intake", label: "Intake" },
  { href: "/ledger", label: "Completed Ledger" },
  { href: "/stores", label: "Store Settings" },
];

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-dot" aria-hidden />
        <span>
          LacityCars
          <small>Stocking Operations</small>
        </span>
      </div>
      <nav aria-label="Primary">
        {LINKS.map((link) => {
          const active =
            link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className="nav-link"
              aria-current={active ? "page" : undefined}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <button type="button" className="btn btn-sm" onClick={logout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
