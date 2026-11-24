import type { ReactElement } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router-dom";
import { vi } from "vitest";
import { App, routes } from "./App";
import { DensityProvider } from "./components/DensityProvider";
import { RecentNetworksProvider } from "./components/RecentNetworksProvider";
import { WalletConnectionProvider } from "./components/WalletConnection/WalletConnectionContext";

vi.mock("@stellar/freighter-api", () => ({
  isConnected: vi.fn(() => new Promise(() => {})),
  requestAccess: vi.fn().mockResolvedValue({ address: "", error: undefined }),
  getAddress: vi.fn().mockResolvedValue({ address: "", error: undefined }),
  getNetworkDetails: vi.fn().mockResolvedValue({
    network: "TESTNET",
    networkPassphrase: "Test SDF Network ; September 2015",
    error: undefined,
  }),
}));

vi.mock("./lib/soroban/revoraContract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/soroban/revoraContract")>();
  return {
    ...actual,
    getContractSummary: vi.fn().mockResolvedValue({
      periodCount: 3,
      authorizedOfferingsCount: 2,
    }),
    getPeriodIds: vi.fn().mockResolvedValue([1, 2, 3]),
    getPeriod: vi.fn().mockResolvedValue({
      start_ledger: 100,
      end_ledger: 200,
      revenue_amount: 1000n,
      is_complete: true,
    }),
    hasClaimed: vi.fn().mockResolvedValue(false),
    getUnclaimedSummary: vi.fn().mockResolvedValue([]),
    getAuthorizedOfferings: vi.fn().mockResolvedValue([]),
  };
});

function withProviders(ui: ReactElement) {
  return (
    <DensityProvider>
      <RecentNetworksProvider>
        <WalletConnectionProvider>{ui}</WalletConnectionProvider>
      </RecentNetworksProvider>
    </DensityProvider>
  );
}

function renderAtPath(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(withProviders(<RouterProvider router={router} />));
}

function collectRoutePaths(routeList: RouteObject[], parentPath = ""): string[] {
  const paths: string[] = [];
  for (const route of routeList) {
    let fullPath = parentPath;
    if (route.path) {
      if (route.path === "*") {
        fullPath = "/__not-found-404__";
      } else if (route.path.startsWith("/")) {
        fullPath = route.path;
      } else {
        fullPath = `${parentPath.replace(/\/$/, "")}/${route.path}`;
      }
    }

    if (route.children && route.children.length > 0) {
      paths.push(...collectRoutePaths(route.children, fullPath));
    } else if (fullPath) {
      paths.push(fullPath);
    }
  }
  return paths;
}

const allRoutePaths = collectRoutePaths(routes);

describe('App Components Accessibility', () => {
  it('renders standard links and buttons correctly', () => {
    renderAtPath("/");
    
    // Test that the 'Get started' and 'Sign In' links render and have href attributes
    const getStartedLink = screen.getByText('Get started');
    const signInLink = screen.getByText('Sign In');
    
    expect(getStartedLink).toBeInTheDocument();
    expect(getStartedLink.tagName.toLowerCase()).toBe('a');
    expect(signInLink).toBeInTheDocument();
    expect(signInLink.tagName.toLowerCase()).toBe('a'); 
  });

  it('renders the header correctly', () => {
    renderAtPath("/");
    const heading = screen.getByRole('heading', { name: /Revora on Stellar/i });
    expect(heading).toBeInTheDocument();
  });

  it.each([
    ["/login", "Welcome to Revora"],
    ["/signup", "Choose your account type"],
    ["/forgot-password", "Forgot Password?"],
    ["/startup/dashboard", "Acme Corp Dashboard"],
    ["/investor/portal", "Discover Offerings"],
  ])("renders the existing route %s", (path, heading) => {
    renderAtPath(path);
    expect(
      screen.getByRole("heading", { name: heading }),
    ).toBeInTheDocument();
  });

  it('provides a skip-to-content link that moves focus to main', async () => {
    render(withProviders(<App />));
    const user = userEvent.setup();

    const skipLink = screen.getByRole('link', { name: /skip to main content/i });
    const main = screen.getByRole('main');

    await user.tab();
    expect(skipLink).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(main).toHaveFocus();
  });

  it('uses a single main landmark on each route', () => {
    render(withProviders(<App />));
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('does not throw if skip target is missing', async () => {
    render(withProviders(<App />));
    const user = userEvent.setup();

    const skipLink = screen.getByRole('link', { name: /skip to main content/i });
    const originalGetElementById = document.getElementById.bind(document);
    const getElementByIdSpy = vi.spyOn(document, 'getElementById').mockImplementation((id: string) => {
      if (id === 'main-content') return null;
      return originalGetElementById(id);
    });

    await user.click(skipLink);
    expect(skipLink).toBeInTheDocument();
    getElementByIdSpy.mockRestore();
  });

  it('enforces one h1 on the investor discovery route and keeps heading hierarchy', () => {
    window.history.pushState({}, '', '/investor/portal');
    render(withProviders(<App />));

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: /discover offerings/i })).toBeInTheDocument();

    expect(screen.getByRole('heading', { level: 2, name: /offerings/i })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0);
  });

  it('renders the startup dashboard route', () => {
    window.history.pushState({}, '', '/startup/dashboard');
    render(withProviders(<App />));
    expect(screen.getByRole('heading', { level: 1, name: /acme corp dashboard/i })).toBeInTheDocument();
  });

  it('renders the offering registration route with its document uploader', () => {
    window.history.pushState({}, '', '/startup/offering-registration');
    render(withProviders(<App />));
    expect(screen.getByRole('heading', { level: 1, name: /offering registration/i })).toBeInTheDocument();
    expect(screen.getByText('Upload KYC documents')).toBeInTheDocument();
  });

  it('sets aria-current="page" on the Investor nav link for /investor/portfolio', () => {
    renderAtPath('/investor/portfolio');

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const activeLinks = nav.querySelectorAll('[aria-current]');

    expect(activeLinks).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Investor' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Startup' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Admin' })).not.toHaveAttribute('aria-current');
  });

  it.each([
    ['/startup/dashboard', 'Startup'],
    ['/investor/portfolio', 'Investor'],
    ['/admin/alerts', 'Admin'],
  ])('marks exactly one primary nav link as current on %s', (path, activeName) => {
    renderAtPath(path);

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const activeLinks = nav.querySelectorAll('[aria-current="page"]');

    expect(activeLinks).toHaveLength(1);
    expect(screen.getByRole('link', { name: activeName })).toHaveAttribute('aria-current', 'page');
  });

  it('renders home section list items without literal bullet characters and preserves plain-text items', () => {
    renderAtPath('/');

    const lists = screen.getAllByRole('list');
    expect(lists.length).toBeGreaterThanOrEqual(3);

    const items = screen.getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      expect(item.textContent).not.toContain('•');
    }

    const configureItem = screen.getByText('Configure RevenueShare offerings');
    expect(configureItem.tagName.toLowerCase()).toBe('li');
    expect(configureItem.querySelector('a')).toBeNull();

    const investItem = screen.getByText('Invest using USDC on Stellar');
    expect(investItem.tagName.toLowerCase()).toBe('li');
    expect(investItem.querySelector('a')).toBeNull();
  });
});

describe('Route Smoke & Accessibility', () => {
  it.each(allRoutePaths)(
    'renders route %s with landmarks, h1, no console errors, and no axe violations',
    async (path) => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        let container!: HTMLElement;
        await act(async () => {
          ({ container } = renderAtPath(path));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        // Landmarks
        expect(screen.getAllByRole('main')).toHaveLength(1);
        expect(screen.getByRole('banner')).toBeInTheDocument();
        expect(screen.getByRole('contentinfo')).toBeInTheDocument();
        expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();

        // Exactly one top-level h1 heading per route
        const h1s = screen.getAllByRole('heading', { level: 1 });
        expect(h1s).toHaveLength(1);

        // Color contrast is excluded because jsdom does not compute CSS styles/backgrounds reliably.
        const axeResults = await axe(container, {
          rules: {
            'color-contrast': { enabled: false },
          },
        });
        expect(axeResults).toHaveNoViolations();
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
      }
    },
  );
});
