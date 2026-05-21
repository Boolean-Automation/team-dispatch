// dispatch — App root
// Slice 2: wraps routes in RequireAuth so unauthenticated visitors see
// the Clerk sign-in UI instead of the application.

import React from "react";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRoutes } from "./routes";
import { RequireAuth } from "./lib/clerk";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Global default — board queries override with their own refetchInterval.
      staleTime: 20_000,
      retry: 2,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <RequireAuth>
          <AppRoutes />
        </RequireAuth>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
