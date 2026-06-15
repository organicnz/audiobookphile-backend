import { SupabaseClient, User } from "npm:@supabase/supabase-js"
import { Database } from "../../../../src/types/supabase.ts"

export type Variables = {
  supabaseUrl: string
  serviceRoleKey: string
  supabase: SupabaseClient<Database>
  user: User | null
  requireUser: () => Promise<User>
}
