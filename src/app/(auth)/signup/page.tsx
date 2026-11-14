"use client";

import { useActionState } from "react";
import { signupAction, type SignupState } from "@/server/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: SignupState = {};

export default function SignupPage() {
  const [state, action, pending] = useActionState(signupAction, initialState);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Create your clinic</h1>
        <p className="text-sm text-muted-foreground">Ten minutes to your first prescription.</p>
      </div>
      <form action={action} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="clinicName">Clinic name</Label>
          <Input id="clinicName" name="clinicName" required minLength={2} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="doctorName">Your name</Label>
          <Input
            id="doctorName"
            name="doctorName"
            required
            minLength={2}
            placeholder="Dr. Meera Shah"
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              name="phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              required
              pattern="[0-9]{10,15}"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={72}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">City</Label>
            <Input id="city" name="city" />
          </div>
        </div>
        <input type="hidden" name="country" value="IN" />
        <input type="hidden" name="timezone" value="Asia/Kolkata" />
        <input type="hidden" name="currency" value="INR" />
        {state.error ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Creating clinic…" : "Create clinic"}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Already have an account?{" "}
        <a className="underline" href="/login">
          Sign in
        </a>
      </p>
    </main>
  );
}
