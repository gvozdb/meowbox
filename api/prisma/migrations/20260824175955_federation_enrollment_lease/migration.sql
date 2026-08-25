-- AlterTable
ALTER TABLE "federation_enrollments" ADD COLUMN "lease_until" DATETIME;

-- CreateIndex
CREATE INDEX "federation_enrollments_enrollment_role_lease_until_idx" ON "federation_enrollments"("enrollment_role", "lease_until");
