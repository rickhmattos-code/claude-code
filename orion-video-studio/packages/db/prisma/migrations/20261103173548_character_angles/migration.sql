-- CreateEnum
CREATE TYPE "CharacterAngle" AS ENUM ('SHEET', 'FRONT', 'THREE_QUARTER', 'PROFILE');

-- AlterTable
ALTER TABLE "CharacterReference" ADD COLUMN     "angle" "CharacterAngle";
