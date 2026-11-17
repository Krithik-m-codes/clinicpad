import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { getDoctorProfile } from "@/server/services/pad-settings";
import { removeSignatureAction, uploadSignatureAction } from "@/server/actions/settings";
import { DoctorProfileForm } from "@/components/settings/doctor-profile-form";
import { ImageUploadForm } from "@/components/settings/image-upload-form";

export const dynamic = "force-dynamic";

export default async function DoctorProfilePage() {
  const session = await requireSession();
  if (!can(session.role, "settings.profile")) redirect("/dashboard");

  const profile = await getDoctorProfile(session);

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold">Doctor profile</h1>
      {profile.ok ? (
        <>
          <DoctorProfileForm initial={profile.value} />
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Signature</h2>
            <ImageUploadForm
              label="Signature"
              hint="A PNG or JPEG of your signature on white paper, up to 512 KB. Printed above your name on every prescription you finalize."
              current={profile.value.signature}
              upload={uploadSignatureAction}
              remove={removeSignatureAction}
            />
          </section>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{profile.message}</p>
      )}
    </div>
  );
}
