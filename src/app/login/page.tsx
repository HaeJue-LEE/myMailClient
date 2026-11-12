import { UpdatePrompt } from "@/features/mail/components/app-update";
import { LoginScreen } from "@/features/mail/components/login-screen";

export default function LoginPage() {
  return (
    <>
      <LoginScreen />
      {/* Updates are offered before any account is added, too; with no sidebar, the version shows here. */}
      <UpdatePrompt showVersion />
    </>
  );
}
