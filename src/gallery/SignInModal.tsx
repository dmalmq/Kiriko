import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { KirikoMark } from "../components/icons";
import type { LocaleCode } from "../imdf/types";
import { api, ApiError, type ApiUser } from "./api";

const ui = {
  title: { ja: "Kiriko にサインイン", en: "Sign in to Kiriko" },
  // The identifier is an email address in practice. The field stays a plain
  // text input rather than `type="email"`, because short account names still
  // sign in and browser validation would reject them.
  email: { ja: "メールアドレス", en: "Email" },
  password: { ja: "パスワード", en: "Password" },
  submit: { ja: "サインイン", en: "Sign in" },
  cancel: { ja: "キャンセル", en: "Cancel" },
  wrong: {
    ja: "メールアドレスまたはパスワードが違います",
    en: "Wrong email or password.",
  },
  failed: { ja: "サインインに失敗しました", en: "Sign-in failed" },
} as const;

export interface SignInModalProps {
  locale: LocaleCode;
  onSignedIn: (user: ApiUser) => void;
  onCancel?: () => void;
}

export function SignInModal({ locale, onSignedIn, onCancel }: SignInModalProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    usernameRef.current?.focus();
    return () => {
      activeRef.current = false;
      returnFocus?.focus();
    };
  }, []);

  const cancel = () => {
    if (onCancel !== undefined) {
      onCancel();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape" && onCancel !== undefined) {
      event.preventDefault();
      cancel();
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    api
      .login(username, password)
      .then((user) => {
        if (activeRef.current) {
          onSignedIn(user);
        }
      })
      .catch((err: unknown) => {
        if (activeRef.current) {
          setError(err instanceof ApiError && err.status === 401 ? ui.wrong[locale] : ui.failed[locale]);
        }
      })
      .finally(() => {
        if (activeRef.current) {
          setBusy(false);
        }
      });
  };

  return (
    <div className="modal-overlay">
      <form
        className="signin-card"
        onSubmit={onSubmit}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={ui.title[locale]}
      >
        <div className="signin-card__brand">
          <KirikoMark size={32} className="signin-card__mark" />
          <h2 className="signin-card__title">{ui.title[locale]}</h2>
        </div>
        <div className="kiriko-input">
          <input
            ref={usernameRef}
            aria-label={ui.email[locale]}
            placeholder={ui.email[locale]}
            autoComplete="username"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />
        </div>
        <div className="kiriko-input">
          <input
            type="password"
            aria-label={ui.password[locale]}
            placeholder={ui.password[locale]}
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </div>
        {error !== null ? (
          <p className="signin-card__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="signin-card__actions">
          {onCancel !== undefined ? (
            <button type="button" className="btn-ghost" disabled={busy} onClick={cancel}>
              {ui.cancel[locale]}
            </button>
          ) : null}
          <button type="submit" className="btn-primary signin-card__submit" disabled={busy}>
            {ui.submit[locale]}
          </button>
        </div>
      </form>
    </div>
  );
}
