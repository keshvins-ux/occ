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
import POIntake from "./sections/POIntake";
import CreateDO from "./sections/CreateDO";
import CreateInvoice from "./sections/CreateInvoice";
import DocumentTracker from "./sections/DocumentTracker";
import ProductionOverview from "./sections/ProductionOverview";
import ProductionQueue from "./sections/ProductionQueue";
import ProductionGap from "./sections/ProductionGap";
import ProductionPurchase from "./sections/ProductionPurchase";
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
  // Documents (PO Intake + DO + Invoice + Tracker)
  if (section === "po") {
    if (sub === 0) return <POIntake />;
    if (sub === 1) return <CreateDO />;
    if (sub === 2) return <CreateInvoice />;
    if (sub === 3) return <DocumentTracker />;
    return <POIntake />;
  }
  // Production
  if (section === "production") {
    if (sub === 0) return <ProductionOverview />;
    if (sub === 1) return <ProductionQueue />;
    if (sub === 2) return <ProductionGap />;
    if (sub === 3) return <ProductionPurchase />;
    return <Placeholder title="Coming Soon" description="This production feature is under development." icon="factory" />;
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
