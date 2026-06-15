import { S3Client, GetObjectCommand } from 'npm:@aws-sdk/client-s3'
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner'
import { SupabaseClient } from 'npm:@supabase/supabase-js'

export class StorageRouter {
  constructor(private supabase: SupabaseClient) {}

  async getSignedUrl(path: string, expiresIn: number): Promise<string> {
    if (path.startsWith('supabase://')) {
      const actualPath = path.replace('supabase://', '')
      const { data, error } = await this.supabase.storage
        .from('audio-files')
        .createSignedUrl(actualPath, expiresIn)

      if (error || !data?.signedUrl) {
        throw new Error(`Supabase presign failed: ${error?.message}`)
      }
      return data.signedUrl
    }

    if (path.startsWith('b2://') || (!path.includes('://'))) {
      const actualPath = path.replace('b2://', '')
      
      const s3Client = new S3Client({
        endpoint: Deno.env.get('B2_ENDPOINT')!,
        region: Deno.env.get('B2_REGION') || 'us-west-004',
        credentials: {
          accessKeyId: Deno.env.get('B2_KEY_ID')!,
          secretAccessKey: Deno.env.get('B2_APP_KEY')!,
        },
        forcePathStyle: true,
      })
      
      const command = new GetObjectCommand({
        Bucket: Deno.env.get('B2_BUCKET_NAME')!,
        Key: actualPath,
      })
      
      return await getSignedUrl(s3Client, command, { expiresIn })
    }

    throw new Error(`Unsupported storage provider for path: ${path}`)
  }
}
