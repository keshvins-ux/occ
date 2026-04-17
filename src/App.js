import { useState } from "react";
import Layout from "./components/Layout";
import LoginScreen from "./components/LoginScreen";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { DateRangeProvider } from "./contexts/DateRangeContext";

// Section components
import SalesOverview from "./sections/SalesOverview";
import SalesPipeline from "./sections/SalesPipeline";
import SalesAnalytics from "./sections/SalesAnalytics";
import ManagementAROverview from "./sections/ManagementAROverview";
import ManagementCustomers from "./sections/ManagementCustomers";
import ManagementSOLifecycle from "./sections/ManagementSOLifecycle";
import Placeholder from "./sections/Placeholder";

function AppInner() {
  const { user, loading } = useAuth();
  const [section, setSection] = useState("sales");
  const [sub, setSub] = useState(0);

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
          color: "#64748B",
          fontSize: 14,
        }}
      >
        Loading OCC…
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  const onNavigate = (id, subIndex = 0) => {
    setSection(id);
    setSub(subIndex);
  };

  return (
    <Layout active={section} sub={sub} onNavigate={onNavigate}>
      {renderSection(section, sub)}
    </Layout>
  );
}

function renderSection(section, sub) {
  // Sales
  if (section === "sales") {
    if (sub === 0) return <SalesOverview />;
    if (sub === 1) return <SalesPipeline />;
    if (sub === 2) return <SalesAnalytics />;
  }
  // Management
  if (section === "management") {
    if (sub === 0) return <ManagementAROverview />;
    if (sub === 1) return <ManagementCustomers />;
    if (sub === 2) return <ManagementSOLifecycle />;
  }
  // PO Intake (Session 2)
  if (section === "po") {
    return (
      <Placeholder
        title="PO Intake"
        description="AI-powered PO extraction with confidence scoring, customer self-learning, and Document Tracker with accurate SO→DO→Invoice linking. Migrating from v1 in Session 2."
        icon="download"
      />
    );
  }
  // Production (Session 2)
  if (section === "production") {
    return (
      <Placeholder
        title="Production"
        description="Customer-order-first queue, gap analysis, purchase list with item descriptions, machine capacity planning, and real-time Floor Display — all reading from live Postgres."
        icon="factory"
      />
    );
  }
  // Procurement (Session 2)
  if (section === "procurement") {
    return (
      <Placeholder
        title="Procurement"
        description="Supplier POs, GRN, stock overview, and supplier directory — all backed by Postgres (sql_purchaseorders, sql_purchaseinvoices, sql_stockitems, sql_suppliers)."
        icon="cart"
      />
    );
  }
  // Compliance (Phase 5)
  if (section === "compliance") {
    return (
      <Placeholder
        title="Halal Compliance"
        description="Supplier certificate tracking, batch traceability, and cleaning logs for JAKIM audit readiness. Schema designed (5 tables, 3 views) — UI coming in Phase 5."
        icon="shield"
        session="Phase 5"
      />
    );
  }
  return <div style={{ padding: 60, textAlign: "center", color: "#94A3B8", fontSize: 14 }}>Select a section</div>;
}

export default function App() {
  return (
    <AuthProvider>
      <DateRangeProvider>
        <AppInner />
      </DateRangeProvider>
    </AuthProvider>
  );
}
