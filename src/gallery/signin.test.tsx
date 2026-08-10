import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiUser } from "./api";

const login = vi.fn();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { ...actual.api, login: (...a: unknown[]) => login(...a) } };
});

import { SignInModal } from "./SignInModal";

afterEach(() => {
  vi.clearAllMocks();
});

describe("SignInModal", () => {
  it("submits credentials and returns the authenticated user", async () => {
    const authenticatedUser: ApiUser = { id: 1, username: "daniel", role: "admin" };
    login.mockResolvedValue(authenticatedUser);
    const onSignedIn = vi.fn();
    const user = userEvent.setup();
    render(<SignInModal locale="en" onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText("Email"), "daniel");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledWith(authenticatedUser);
    });
    expect(login).toHaveBeenCalledWith("daniel", "secret");
  });

  it("shows the error line on 401 and keeps the form usable", async () => {
    login.mockRejectedValue(new ApiError(401, "invalid_credentials"));
    const user = userEvent.setup();
    render(<SignInModal locale="en" onSignedIn={() => {}} />);

    await user.type(screen.getByLabelText("Email"), "daniel");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Wrong email or password.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("is a cancellable modal, focuses credentials, and restores its opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open sign in
          </button>
          {open ? (
            <SignInModal
              locale="en"
              onCancel={() => setOpen(false)}
              onSignedIn={() => setOpen(false)}
            />
          ) : null}
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open sign in" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Sign in to Kiriko" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Email"));
    });

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
