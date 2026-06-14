USE [master]
GO

IF DB_ID('DevReportsDB') IS NULL
    CREATE DATABASE [DevReportsDB]
GO

USE [DevReportsDB]
GO

-- Tables
CREATE TABLE [dbo].[Projects] (
    [Id]          INT IDENTITY(1,1) NOT NULL,
    [Name]        NVARCHAR(200) NOT NULL,
    [Description] NVARCHAR(MAX) NULL,
    [Status]      NVARCHAR(20) NOT NULL DEFAULT 'ongoing',
    [Immediacy]   NVARCHAR(20) NOT NULL DEFAULT 'normal',
    [CreatedAt]   DATETIME NOT NULL DEFAULT GETDATE(),
    [UpdatedAt]   DATETIME NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
)
GO

CREATE TABLE [dbo].[Users] (
    [Id]       INT IDENTITY(1,1) NOT NULL,
    [Username] NVARCHAR(50) NOT NULL,
    [Password] NVARCHAR(100) NOT NULL,
    [FullName] NVARCHAR(100) NOT NULL,
    [Role]     NVARCHAR(20) NOT NULL,
    [IsActive] BIT NOT NULL DEFAULT 1,
    PRIMARY KEY CLUSTERED ([Id] ASC)
)
GO

ALTER TABLE [dbo].[Users] ADD UNIQUE ([Username])
GO

CREATE TABLE [dbo].[Reports] (
    [Id]              INT IDENTITY(1,1) NOT NULL,
    [UserId]          INT NOT NULL,
    [Content]         NVARCHAR(MAX) NULL,
    [Date]            DATE NULL,
    [Status]          NVARCHAR(20) NOT NULL DEFAULT 'published',
    [Notes]           NVARCHAR(MAX) NULL,
    [ReadAt]          DATETIME NULL,
    [NotesByFullName] NVARCHAR(100) NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    FOREIGN KEY ([UserId]) REFERENCES [dbo].[Users]([Id])
)
GO

CREATE TABLE [dbo].[ReportProjects] (
    [ReportId]  INT NOT NULL,
    [ProjectId] INT NOT NULL,
    PRIMARY KEY CLUSTERED ([ReportId] ASC, [ProjectId] ASC)
)
GO

-- Login & user
IF NOT EXISTS (SELECT * FROM sys.server_principals WHERE name = 'dev_login')
    CREATE LOGIN dev_login WITH PASSWORD = 'Dev12345!'
GO

CREATE USER [dev_login] FOR LOGIN [dev_login] WITH DEFAULT_SCHEMA=[dbo]
GO

ALTER ROLE [db_owner] ADD MEMBER [dev_login]
GO

-- Users data
SET IDENTITY_INSERT [dbo].[Users] ON
INSERT [dbo].[Users] ([Id],[Username],[Password],[FullName],[Role],[IsActive]) VALUES (5,N'admin',N'A@@123456',N'Gabi',N'admin',1)
INSERT [dbo].[Users] ([Id],[Username],[Password],[FullName],[Role],[IsActive]) VALUES (6,N'zeevg',N'Z@@123456',N'Zeev',N'manager',1)
INSERT [dbo].[Users] ([Id],[Username],[Password],[FullName],[Role],[IsActive]) VALUES (7,N'dev_1',N'D1@@123456',N'Dor',N'developer',1)
INSERT [dbo].[Users] ([Id],[Username],[Password],[FullName],[Role],[IsActive]) VALUES (8,N'dev_2',N'D2@@123456',N'Daniel',N'developer',1)
SET IDENTITY_INSERT [dbo].[Users] OFF
GO
