/** Identity of the caller. Always built from the server session, never from request input. */
export type ServiceContext = {
  userId: string;
  tenantId: string;
  role: string;
};
